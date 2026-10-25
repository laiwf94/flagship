import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticateSdk } from '../auth/sdk.js';
import type { Context } from '../context.js';
import type { KeyKind } from '../db/schema.js';
import { AppError } from '../errors.js';
import type { RulesetCache } from '../services/cache.js';
import type { Hub } from '../streaming/hub.js';

export interface SdkDeps {
  cache: RulesetCache;
  hub: Hub;
}

const LAST_EVENT_ID = /^\d{1,15}$/;

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

    sdk.get('/stream', { config: { stream: true } }, (request, reply) =>
      stream(request, reply, ['server'], false),
    );

    sdk.get('/client-stream', { config: { stream: true } }, (request, reply) =>
      stream(request, reply, ['client'], true),
    );
  };
}
