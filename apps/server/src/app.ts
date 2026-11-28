import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import type { Logger } from 'pino';
import { requireScopeDeclaration, sessionGuard } from './auth/guard.js';
import { SignInLimiter } from './auth/ratelimit.js';
import type { Config } from './config.js';
import type { Context } from './context.js';
import type { Db } from './db/database.js';
import { EventBus, EVENTS_CHANNEL } from './events.js';
import { AppError, errorHandler, sendError } from './errors.js';
import { createLogger } from './log.js';
import { createMetrics, type Metrics } from './metrics.js';
import { API_VERSION, ApiCatalog, operations } from './openapi.js';
import { sessionRoutes } from './routes/session.js';
import { changeRequestRoutes } from './routes/changeRequests.js';
import { codeReferenceRoutes } from './routes/codeReferences.js';
import { experimentRoutes } from './routes/experiments.js';
import { flagRoutes } from './routes/flags.js';
import { projectRoutes } from './routes/projects.js';
import { sdkRoutes } from './routes/sdk.js';
import { tokenRoutes } from './routes/tokens.js';
import { userRoutes } from './routes/users.js';
import { webhookRoutes } from './routes/webhooks.js';
import { EgressPolicy } from './egress.js';
import { SecretBox } from './secretbox.js';
import { KeyAuthenticator } from './services/apikeys.js';
import { pruneApiTokens, TokenAuthenticator } from './services/apitokens.js';
import { RulesetCache } from './services/cache.js';
import { ExperimentEventQueue, experimentWriter } from './services/experimentEvents.js';
import { experimentRollup } from './services/experimentRollup.js';
import { rolloutGuards } from './services/guards.js';
import { ExposureQueue, exposureWriter } from './services/exposures.js';
import { lifecycleCheck } from './services/lifecycle.js';
import { Scheduler } from './services/schedules.js';
import { Hub } from './streaming/hub.js';
import { bootstrapProject } from './services/projects.js';
import { safeEqual } from './util.js';
import { bootstrapAdmin } from './services/users.js';
import {
  pruneWebhookDeliveries,
  webhookOutbox,
  WEBHOOKS_CHANNEL,
  WEBHOOKS_CONSUMER,
  WebhookWorker,
} from './services/webhooks.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Long-lived streaming route: excluded from the latency histogram. */
    stream?: boolean;
  }
}

export interface AppDeps {
  config: Config;
  db: Db;
  logger?: Logger;
  /** Injectable clock for expiry tests. */
  now?: () => Date;
}

export interface App {
  server: FastifyInstance;
  metrics: Metrics;
  ctx: Context;
  hub: Hub;
  /** Committed changes, for in-process handlers and durable consumers. */
  events: EventBus;
  cache: RulesetCache;
  scheduler: Scheduler;
  exposures: ExposureQueue;
  experiments: ExperimentEventQueue;
  /** Delivers webhook outbox rows. */
  webhooks: WebhookWorker;
  /** Every /api operation, and the OpenAPI document built from them. */
  api: ApiCatalog;
  /** Stops accepting work, drains streams and background jobs, closes the server. */
  close: () => Promise<void>;
}

const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export async function buildApp(deps: AppDeps): Promise<App> {
  const { config, db } = deps;
  const metrics = createMetrics();
  const now = deps.now ?? (() => new Date());
  const ctx: Context = {
    config,
    db,
    metrics,
    now,
    keys: new KeyAuthenticator(db, now),
    tokens: new TokenAuthenticator(db, now),
    secrets: config.secretKey === undefined ? undefined : new SecretBox(config.secretKey),
    egress: new EgressPolicy(config.webhookAllowedTargets),
  };
  const limiter = new SignInLimiter(db);
  const logger = deps.logger ?? createLogger(config.logLevel);
  // Widened so the instance type stays FastifyInstance with the default logger.
  const baseLogger: FastifyBaseLogger = logger;
  let draining = false;

  const server = Fastify({
    loggerInstance: baseLogger,
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
    return503OnClosing: true,
    requestIdHeader: false,
    genReqId: (req) => {
      const given = req.headers['x-request-id'];
      return typeof given === 'string' && REQUEST_ID.test(given) ? given : randomUUID();
    },
  });

  server.decorateRequest('user', null);
  server.decorateRequest('session', null);
  server.decorateRequest('apiToken', null);
  await server.register(cookie);
  server.setErrorHandler(errorHandler);
  const uiDir = config.adminUiDir;
  if (uiDir !== undefined) {
    await server.register(fastifyStatic, { root: uiDir, wildcard: false, index: false });
  }
  server.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0] ?? '';
    // Client-side routes of the admin UI all load index.html.
    if (
      uiDir !== undefined &&
      (request.method === 'GET' || request.method === 'HEAD') &&
      !/^\/(api|sdk|metrics|healthz|readyz)(\/|$)/.test(path)
    ) {
      return reply
        .header('cache-control', 'no-cache')
        .sendFile('index.html', { cacheControl: false });
    }
    return sendError(
      reply,
      request,
      new AppError('not_found', `no route for ${request.method} ${path}`),
    );
  });

  server.addHook('onRequest', async (request, reply) => {
    void reply.header('x-request-id', request.id);
    void reply.headers({
      'content-security-policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
        "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
      'x-frame-options': 'DENY',
    });
    if (draining && !request.url.startsWith('/healthz')) {
      throw new AppError('unavailable', 'server is shutting down', undefined, {
        'retry-after': '1',
      });
    }
  });

  server.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url ?? 'unmatched';
    metrics.httpRequests.inc({ method: request.method, route, status: String(reply.statusCode) });
    if (request.routeOptions.config.stream !== true) {
      metrics.httpDuration.observe(reply.elapsedTime / 1000, { route });
    }
  });

  server.get('/healthz', async () => ({ status: 'ok' }));

  server.get('/readyz', async () => {
    if (draining) throw new AppError('unavailable', 'server is shutting down');
    try {
      await sql`SELECT 1`.execute(db);
    } catch (err) {
      server.log.warn({ err }, 'readiness check failed');
      throw new AppError('unavailable', 'database is unreachable');
    }
    return { status: 'ready' };
  });

  server.get('/metrics', async (request, reply) => {
    if (config.metricsToken !== undefined) {
      const auth = request.headers.authorization ?? '';
      if (!safeEqual(auth, `Bearer ${config.metricsToken}`)) {
        throw new AppError('unauthenticated', 'metrics need the configured bearer token');
      }
    } else if (!LOOPBACK.has(request.socket.remoteAddress ?? '')) {
      throw new AppError(
        'permission_denied',
        'metrics are only served to loopback unless FLAGSHIP_METRICS_TOKEN is set',
      );
    }
    return reply.type('text/plain; version=0.0.4; charset=utf-8').send(metrics.registry.render());
  });

  const catalog = new ApiCatalog('/api', API_VERSION);
  await server.register(
    async (api) => {
      api.addHook('onRoute', requireScopeDeclaration);
      api.addHook('onRoute', catalog.onRoute);
      api.addHook('onRequest', sessionGuard(ctx));
      api.get(
        '/openapi.json',
        {
          config: {
            public: true,
            openapi: operations('meta')('getOpenApiDocument', 'This OpenAPI 3.1 document'),
          },
        },
        async (_request, reply) =>
          reply.header('cache-control', 'no-cache').send(catalog.document()),
      );
      await api.register(sessionRoutes(ctx, limiter));
      await api.register(tokenRoutes(ctx));
      await api.register(userRoutes(ctx));
      await api.register(projectRoutes(ctx));
      await api.register(flagRoutes(ctx));
      await api.register(changeRequestRoutes(ctx));
      await api.register(experimentRoutes(ctx));
      await api.register(webhookRoutes(ctx));
      await api.register(codeReferenceRoutes(ctx));
    },
    { prefix: '/api' },
  );
  const cache = new RulesetCache(db, metrics);
  const events = new EventBus({ db, logger, metrics });
  const webhooks = new WebhookWorker({
    db,
    secrets: ctx.secrets,
    egress: ctx.egress,
    metrics,
    logger,
    now,
    timeoutMs: config.webhookTimeoutMs,
    concurrency: config.webhookConcurrency,
    pollMs: config.webhookPollMs,
  });
  const hub = new Hub({
    db,
    databaseUrl: config.databaseUrl,
    cache,
    metrics,
    logger,
    heartbeatMs: config.heartbeatSeconds * 1000,
    maxStreams: config.maxStreams,
    maxStreamsPerKey: config.maxStreamsPerKey,
    channels: {
      [EVENTS_CHANNEL]: () => {
        events.wake();
      },
      [WEBHOOKS_CHANNEL]: () => {
        webhooks.wake();
      },
    },
  });
  await hub.start();
  events.start();
  events.consume(WEBHOOKS_CONSUMER, webhookOutbox(now));
  webhooks.start();
  const exposures = new ExposureQueue({
    write: exposureWriter(db),
    limit: config.eventsQueueLimit,
    flushMs: config.eventsFlushMs,
    metrics,
    logger,
    now,
  });
  exposures.start();
  const experiments = new ExperimentEventQueue({
    write: experimentWriter(db),
    limit: config.eventsQueueLimit,
    flushMs: config.eventsFlushMs,
    metrics,
    logger,
    now,
  });
  experiments.start();
  await server.register(sdkRoutes(ctx, { cache, hub, exposures, experiments }), {
    prefix: '/sdk/v1',
  });

  const admin = await bootstrapAdmin(db, config.bootstrapAdmin);
  if (admin !== undefined) await bootstrapProject(db, { id: admin.id, name: admin.name });

  const scheduler = new Scheduler({
    db,
    metrics,
    logger,
    now,
    intervalMs: config.schedulerIntervalMs,
    retention: config.changeRetention,
    housekeeping: [
      { name: 'login_attempts', everyMs: 60_000, run: (at) => limiter.prune(at) },
      // Hourly turns, each checking the rows not checked in the last day.
      { name: 'lifecycle', everyMs: 3_600_000, run: lifecycleCheck({ db, metrics, logger }) },
      // Hourly cohorts, each recomputed after new events touch it.
      {
        name: 'experiment_rollup',
        everyMs: config.rollupIntervalMs,
        run: experimentRollup({
          db,
          metrics,
          logger,
          // Guarded rollouts are judged on the numbers just rolled up.
          after: rolloutGuards({ db, metrics, logger, retention: config.changeRetention }),
        }),
      },
      { name: 'api_tokens', everyMs: 3_600_000, run: pruneApiTokens(db) },
      {
        name: 'webhook_deliveries',
        everyMs: 3_600_000,
        run: pruneWebhookDeliveries(db, config.webhookRetentionDays),
      },
    ],
  });
  scheduler.start();

  const closers: (() => Promise<void>)[] = [
    () => scheduler.stop(),
    () => hub.close(),
    () => events.close(),
    () => webhooks.close(),
    () => exposures.stop(),
    () => experiments.stop(),
  ];

  await server.ready();

  return {
    server,
    metrics,
    ctx,
    hub,
    events,
    cache,
    scheduler,
    exposures,
    experiments,
    webhooks,
    api: catalog,
    close: async () => {
      draining = true;
      for (const close of closers) await close();
      await server.close();
    },
  };
}
