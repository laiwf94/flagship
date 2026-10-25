import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser } from '../auth/guard.js';
import type { Context } from '../context.js';
import { parse } from '../errors.js';
import { createUser, listUsers, updateUser } from '../services/users.js';
import { passwordSchema } from './session.js';

const role = z.enum(['viewer', 'editor', 'admin']);
const name = z.string().trim().min(1).max(100);

const createSchema = z.strictObject({
  email: z.email().max(254),
  name,
  role,
  password: passwordSchema,
});

const updateSchema = z.strictObject({
  name: name.optional(),
  role: role.optional(),
  disabled: z.boolean().optional(),
});

const idParams = z.object({ id: z.uuid() });

export function userRoutes(ctx: Context) {
  return async (api: FastifyInstance): Promise<void> => {
    api.get('/users', { config: { role: 'admin' } }, async () => ({
      users: await listUsers(ctx.db),
    }));

    api.post('/users', { config: { role: 'admin' } }, async (request, reply) => {
      const actor = currentUser(request);
      const body = parse(createSchema, request.body, 'user');
      const user = await createUser(ctx.db, body, { id: actor.id, name: actor.name });
      return reply.status(201).send(user);
    });

    api.patch('/users/:id', { config: { role: 'admin' } }, async (request) => {
      const actor = currentUser(request);
      const { id } = parse(idParams, request.params, 'user id');
      const body = parse(updateSchema, request.body, 'user');
      return updateUser(ctx.db, id, body, { id: actor.id, name: actor.name });
    });
  };
}
