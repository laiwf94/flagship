import { keySchema } from '@flagship/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser } from '../auth/guard.js';
import type { Context } from '../context.js';
import { parse } from '../errors.js';
import { createApiKey, listApiKeys, revokeApiKey } from '../services/apikeys.js';
import {
  createEnvironment,
  createProject,
  getEnvironment,
  getProject,
  listProjects,
} from '../services/projects.js';

const name = z.string().trim().min(1).max(100);
const envInput = z.strictObject({ key: keySchema, name });
const projectInput = z.strictObject({
  key: keySchema,
  name,
  environments: z.array(envInput).min(1).max(20).optional(),
});
const keyInput = z.strictObject({ kind: z.enum(['server', 'client']), name });

export const projectParams = z.object({ project: keySchema });
export const envParams = z.object({ project: keySchema, environment: keySchema });

export function projectRoutes(ctx: Context) {
  const environment = async (params: unknown) => {
    const p = parse(envParams, params, 'path');
    const project = await getProject(ctx.db, p.project);
    const env = await getEnvironment(ctx.db, project.id, p.environment);
    return { id: env.id, projectId: project.id, key: env.key };
  };

  return async (api: FastifyInstance): Promise<void> => {
    api.get('/projects', async () => ({ projects: await listProjects(ctx.db) }));

    api.post('/projects', { config: { role: 'admin' } }, async (request, reply) => {
      const user = currentUser(request);
      const body = parse(projectInput, request.body, 'project');
      return reply.status(201).send(await createProject(ctx.db, body, user));
    });

    api.post(
      '/projects/:project/environments',
      { config: { role: 'admin' } },
      async (request, reply) => {
        const user = currentUser(request);
        const { project } = parse(projectParams, request.params, 'path');
        const body = parse(envInput, request.body, 'environment');
        return reply.status(201).send(await createEnvironment(ctx.db, project, body, user));
      },
    );

    api.get(
      '/projects/:project/environments/:environment/api-keys',
      { config: { role: 'admin' } },
      async (request) => ({
        keys: await listApiKeys(ctx.db, (await environment(request.params)).id),
      }),
    );

    api.post(
      '/projects/:project/environments/:environment/api-keys',
      { config: { role: 'admin' } },
      async (request, reply) => {
        const user = currentUser(request);
        const env = await environment(request.params);
        const body = parse(keyInput, request.body, 'API key');
        return reply.status(201).send(await createApiKey(ctx.db, env, body, user));
      },
    );

    api.delete(
      '/projects/:project/environments/:environment/api-keys/:id',
      { config: { role: 'admin' } },
      async (request, reply) => {
        const user = currentUser(request);
        const env = await environment(request.params);
        const { id } = parse(z.object({ id: z.uuid() }), request.params, 'path');
        await revokeApiKey(ctx.db, env, id, user);
        return reply.status(204).send();
      },
    );
  };
}
