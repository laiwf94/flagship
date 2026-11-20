import { keySchema } from '@flagship/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser } from '../auth/guard.js';
import { SCOPES } from '../auth/scopes.js';
import type { Context } from '../context.js';
import { parse } from '../errors.js';
import {
  createApiToken,
  listApiTokens,
  MAX_TOKEN_DAYS,
  revokeApiToken,
} from '../services/apitokens.js';
import { actorOf } from './note.js';

const tokenInput = z.strictObject({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(SCOPES)).min(1).max(SCOPES.length),
  project: keySchema.optional(),
  environments: z.array(keySchema).min(1).max(20).optional(),
  expiresInDays: z.int().min(1).max(MAX_TOKEN_DAYS),
});

/**
 * API token management. Session-only: a token can't list, mint or revoke
 * tokens, so a leaked one can't extend itself.
 */
export function tokenRoutes(ctx: Context) {
  const session = { config: { sessionOnly: true } };
  return async (api: FastifyInstance): Promise<void> => {
    api.get('/tokens', session, async (request) => ({
      tokens: await listApiTokens(ctx.db, currentUser(request).id, ctx.now()),
      scopes: SCOPES,
    }));

    api.post('/tokens', session, async (request, reply) => {
      const user = currentUser(request);
      const body = parse(tokenInput, request.body, 'API token');
      const created = await createApiToken(ctx.db, user, body, ctx.now(), actorOf(request));
      return reply.status(201).send(created);
    });

    api.delete('/tokens/:id', session, async (request, reply) => {
      const user = currentUser(request);
      const { id } = parse(z.object({ id: z.uuid() }), request.params, 'path');
      await revokeApiToken(ctx.db, user, id, ctx.now(), actorOf(request));
      return reply.status(204).send();
    });
  };
}
