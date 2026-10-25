import { randomUUID, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import type { Db } from './db/database.js';
import { AppError, errorHandler, sendError } from './errors.js';
import { createLogger } from './log.js';
import { createMetrics, type Metrics } from './metrics.js';

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
}

export interface App {
  server: FastifyInstance;
  metrics: Metrics;
  /** Stops accepting work, drains streams and background jobs, closes the server. */
  close: () => Promise<void>;
}

const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function buildApp(deps: AppDeps): Promise<App> {
  const { config, db } = deps;
  const metrics = createMetrics();
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

  server.setErrorHandler(errorHandler);
  server.setNotFoundHandler((request, reply) =>
    sendError(
      reply,
      request,
      new AppError(
        'not_found',
        `no route for ${request.method} ${request.url.split('?')[0] ?? ''}`,
      ),
    ),
  );

  server.addHook('onRequest', async (request, reply) => {
    void reply.header('x-request-id', request.id);
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

  const closers: (() => Promise<void>)[] = [];

  await server.ready();

  return {
    server,
    metrics,
    close: async () => {
      draining = true;
      for (const close of closers) await close();
      await server.close();
    },
  };
}
