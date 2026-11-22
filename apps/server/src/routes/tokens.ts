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
import { operations } from '../openapi.js';
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
const tokenParams = z.object({ id: z.uuid() });
const op = operations('tokens');

export function tokenRoutes(ctx: Context) {
  return async (api: FastifyInstance): Promise<void> => {
    api.get(
      '/tokens',
      {
        config: {
          sessionOnly: true,
          openapi: op('listApiTokens', 'List your API tokens and the scopes they can hold'),
        },
      },
      async (request) => ({
        tokens: await listApiTokens(ctx.db, currentUser(request).id, ctx.now()),
        scopes: SCOPES,
      }),
    );

    api.post(
      '/tokens',
      {
        config: {
          sessionOnly: true,
          openapi: op('createApiToken', 'Create an API token; the secret is shown once', {
            body: tokenInput,
            status: [201],
          }),
        },
      },
      async (request, reply) => {
        const user = currentUser(request);
        const body = parse(tokenInput, request.body, 'API token');
        const created = await createApiToken(ctx.db, user, body, ctx.now(), actorOf(request));
        return reply.status(201).send(created);
      },
    );

    api.delete(
      '/tokens/:id',
      {
        config: {
          sessionOnly: true,
          openapi: op('revokeApiToken', 'Revoke one of your API tokens', {
            params: tokenParams,
            status: [204],
          }),
        },
      },
      async (request, reply) => {
        const user = currentUser(request);
        const { id } = parse(tokenParams, request.params, 'path');
        await revokeApiToken(ctx.db, user, id, ctx.now(), actorOf(request));
        return reply.status(204).send();
      },
    );
  };
}
