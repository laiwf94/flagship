import type { FastifyInstance } from 'fastify';
import { authenticateSdk } from '../auth/sdk.js';
import type { Context } from '../context.js';

export function sdkRoutes(ctx: Context) {
  return async (sdk: FastifyInstance): Promise<void> => {
    // Lets an SDK (or a person with curl) confirm which environment a key belongs to.
    sdk.get('/environment', async (request) => {
      const id = await authenticateSdk(ctx.keys, request, ['server', 'client']);
      return { project: id.projectKey, environment: id.environmentKey, keyKind: id.kind };
    });
  };
}
