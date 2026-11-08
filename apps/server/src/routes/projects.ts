import { Readable } from 'node:stream';
import { keySchema } from '@flagship/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Context } from '../context.js';
import { parse } from '../errors.js';
import { createApiKey, listApiKeys, revokeApiKey } from '../services/apikeys.js';
import {
  createEnvironment,
  createProject,
  getEnvironment,
  getProject,
  listProjects,
  setChangeNotes,
  setRequiredApprovals,
} from '../services/projects.js';
import { exportProject, importProject, MAX_REQUIRED_APPROVALS } from '../services/transfer.js';
import { actorOf } from './note.js';

const name = z.string().trim().min(1).max(100);
const envInput = z.strictObject({ key: keySchema, name });
const projectInput = z.strictObject({
  key: keySchema,
  name,
  environments: z.array(envInput).min(1).max(20).optional(),
});
const importQuery = z.strictObject({ key: keySchema.optional(), name: name.optional() });
const approvalsInput = z.strictObject({
  requiredApprovals: z.int().min(0).max(MAX_REQUIRED_APPROVALS),
});
const changeNotesInput = z.strictObject({
  requireReason: z.boolean(),
  requireLink: z.boolean(),
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
      const user = actorOf(request);
      const body = parse(projectInput, request.body, 'project');
      return reply.status(201).send(await createProject(ctx.db, body, user));
    });

    api.get('/projects/:project/export', { config: { role: 'admin' } }, async (request, reply) => {
      const { project } = parse(projectParams, request.params, 'path');
      const chunks = exportProject(ctx.db, project, ctx.now);
      // The first chunk is read before any header is sent, so an unknown
      // project is still a clean 404 rather than a broken download.
      const first = await chunks.next();
      async function* rest(): AsyncGenerator<string> {
        try {
          if (first.done !== true) yield first.value;
          yield* chunks;
        } finally {
          await chunks.return(undefined);
        }
      }
      const date = ctx.now().toISOString().slice(0, 10);
      return reply
        .type('application/json; charset=utf-8')
        .header('cache-control', 'no-store')
        .header('content-disposition', `attachment; filename="${project}-${date}.flagship.json"`)
        .send(Readable.from(rest(), { objectMode: false }));
    });

    api.post(
      '/projects/import',
      { config: { role: 'admin' }, bodyLimit: ctx.config.importMaxBytes },
      async (request, reply) => {
        const user = actorOf(request);
        const as = parse(importQuery, request.query, 'query');
        const summary = await importProject(ctx.db, request.body, user, as);
        return reply.status(201).send(summary);
      },
    );

    api.post(
      '/projects/:project/environments',
      { config: { role: 'admin' } },
      async (request, reply) => {
        const user = actorOf(request);
        const { project } = parse(projectParams, request.params, 'path');
        const body = parse(envInput, request.body, 'environment');
        return reply.status(201).send(await createEnvironment(ctx.db, project, body, user));
      },
    );

    api.put(
      '/projects/:project/environments/:environment/approvals',
      { config: { role: 'admin' } },
      async (request) => {
        const user = actorOf(request);
        const env = await environment(request.params);
        const body = parse(approvalsInput, request.body, 'approval settings');
        return setRequiredApprovals(ctx.db, env, body.requiredApprovals, user);
      },
    );

    api.put(
      '/projects/:project/environments/:environment/change-notes',
      { config: { role: 'admin' } },
      async (request) => {
        const user = actorOf(request);
        const env = await environment(request.params);
        const body = parse(changeNotesInput, request.body, 'change note settings');
        return setChangeNotes(ctx.db, env, body, user);
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
        const user = actorOf(request);
        const env = await environment(request.params);
        const body = parse(keyInput, request.body, 'API key');
        return reply.status(201).send(await createApiKey(ctx.db, env, body, user));
      },
    );

    api.delete(
      '/projects/:project/environments/:environment/api-keys/:id',
      { config: { role: 'admin' } },
      async (request, reply) => {
        const user = actorOf(request);
        const env = await environment(request.params);
        const { id } = parse(z.object({ id: z.uuid() }), request.params, 'path');
        await revokeApiKey(ctx.db, env, id, user);
        return reply.status(204).send();
      },
    );
  };
}
