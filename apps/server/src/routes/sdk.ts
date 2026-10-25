import { contextSchema, evaluateAll, keySchema } from '@flagship/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticateSdk } from '../auth/sdk.js';
import type { Context } from '../context.js';
import type { KeyKind } from '../db/schema.js';
import { AppError, parse } from '../errors.js';
import type { RulesetCache } from '../services/cache.js';
import type { ExposureQueue } from '../services/exposures.js';
import type { Hub } from '../streaming/hub.js';

export interface SdkDeps {
  cache: RulesetCache;
  hub: Hub;
  exposures: ExposureQueue;
}

const LAST_EVENT_ID = /^\d{1,15}$/;

const evaluateBody = z.strictObject({ context: contextSchema });

const eventsBody = z.strictObject({
  events: z
    .array(
      z.strictObject({
        flag: keySchema,
        variant: keySchema,
        count: z.int().min(1).max(1_000_000),
        at: z.int().min(0).optional(),
      }),
    )
    .min(1)
    .max(1000),
});

function lastEventId(request: FastifyRequest): number | undefined {
  const raw = request.headers['last-event-id'];
  return typeof raw === 'string' && LAST_EVENT_ID.test(raw) ? Number(raw) : undefined;
}

/**
 * SDK routes are called from other origins (browser apps using a client
 * key), never with cookies, so CORS is open and credentials are off.
 */
function cors(reply: FastifyReply): void {
  void reply.header('access-control-allow-origin', '*');
  void reply.header('access-control-expose-headers', 'etag, retry-after, x-request-id');
}

export function sdkRoutes(ctx: Context, deps: SdkDeps) {
  const stream = async (
    request: FastifyRequest,
    reply: FastifyReply,
    kinds: readonly KeyKind[],
    allowQuery: boolean,
  ) => {
    const id = await authenticateSdk(ctx.keys, request, kinds, allowQuery);
    const refused = deps.hub.canAccept(id);
    if (refused !== undefined) {
      throw new AppError('resource_exhausted', refused, undefined, { 'retry-after': '5' });
    }
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-request-id': request.id,
      'access-control-allow-origin': '*',
    });
    // Ask EventSource to wait a little before reconnecting after a drop.
    res.write('retry: 2000\n\n');
    const state: { gone: boolean; unsubscribe?: () => void } = { gone: false };
    request.raw.on('close', () => {
      state.gone = true;
      state.unsubscribe?.();
    });
    try {
      state.unsubscribe = await deps.hub.subscribe(
        { kind: id.kind, keyId: id.keyId, environmentId: id.environmentId },
        res,
        lastEventId(request),
      );
      // The client may have left while we were writing the snapshot.
      if (state.gone) state.unsubscribe();
    } catch (err) {
      request.log.warn({ err }, 'could not start stream');
      res.end();
    }
  };

  return async (sdk: FastifyInstance): Promise<void> => {
    sdk.addHook('onRequest', async (_request, reply) => {
      cors(reply);
    });

    sdk.options('/*', async (_request, reply) =>
      reply
        .header('access-control-allow-methods', 'GET, POST, OPTIONS')
        .header(
          'access-control-allow-headers',
          'authorization, content-type, last-event-id, if-none-match',
        )
        .header('access-control-max-age', '86400')
        .status(204)
        .send(),
    );

    // Lets an SDK (or a person with curl) confirm which environment a key belongs to.
    sdk.get('/environment', async (request) => {
      const id = await authenticateSdk(ctx.keys, request, ['server', 'client']);
      return { project: id.projectKey, environment: id.environmentKey, keyKind: id.kind };
    });

    sdk.get('/ruleset', async (request, reply) => {
      const id = await authenticateSdk(ctx.keys, request, ['server']);
      const snapshot = await deps.cache.get(id.environmentId);
      void reply.header('etag', snapshot.etag).header('cache-control', 'no-cache');
      if (request.headers['if-none-match'] === snapshot.etag) return reply.status(304).send();
      return reply.type('application/json; charset=utf-8').send(snapshot.json);
    });

    /**
     * Evaluates every client-visible flag for the posted context. The answer
     * holds values, variant keys and reasons only: no rules, no segment
     * members, no rule ids. The context goes in the body, never a URL, so it
     * stays out of access logs and caches.
     */
    sdk.post('/evaluate', { bodyLimit: 64 * 1024 }, async (request, reply) => {
      const id = await authenticateSdk(ctx.keys, request, ['client', 'server']);
      const { context } = parse(evaluateBody, request.body, 'evaluation request');
      const snapshot = await deps.cache.get(id.environmentId);
      const results = evaluateAll(
        snapshot.ruleset,
        context,
        id.kind === 'client' ? (flag) => flag.clientSide : () => true,
      );
      const flags: Record<string, unknown> = {};
      for (const [key, e] of Object.entries(results)) {
        flags[key] =
          e.reason === 'ERROR'
            ? { reason: e.reason, errorCode: e.errorCode }
            : { value: e.value, variant: e.variant, reason: e.reason };
      }
      void reply.header('cache-control', 'no-store');
      return { version: snapshot.version, flags };
    });

    // navigator.sendBeacon posts text/plain so the browser skips the CORS preflight.
    sdk.addContentTypeParser(
      'text/plain',
      { parseAs: 'string', bodyLimit: 256 * 1024 },
      (_req, body, done) => {
        try {
          done(null, JSON.parse(body as string));
        } catch {
          done(new AppError('invalid_argument', 'request body is not valid JSON'), undefined);
        }
      },
    );

    sdk.post('/events', { bodyLimit: 256 * 1024 }, async (request, reply) => {
      const id = await authenticateSdk(ctx.keys, request, ['client', 'server'], true);
      const { events } = parse(eventsBody, request.body, 'events');
      const result = deps.exposures.offer(id.environmentId, events);
      if (result === undefined) {
        throw new AppError('resource_exhausted', 'event queue is full, retry later', undefined, {
          'retry-after': '5',
        });
      }
      return reply.status(202).send({ accepted: events.length, dropped: result.dropped });
    });

    sdk.get('/stream', { config: { stream: true } }, (request, reply) =>
      stream(request, reply, ['server'], false),
    );

    sdk.get('/client-stream', { config: { stream: true } }, (request, reply) =>
      stream(request, reply, ['client'], true),
    );
  };
}
