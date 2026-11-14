import { keySchema } from '@flagship/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Context } from '../context.js';
import { parse } from '../errors.js';
import {
  experimentInput,
  experimentResults,
  getExperiment,
  listExperiments,
  startExperiment,
  stopExperiment,
} from '../services/experiments.js';
import { getEnvironment, getProject } from '../services/projects.js';
import { actorOf } from './note.js';
import { projectParams } from './projects.js';

const experimentParams = z.object({ project: keySchema, experiment: keySchema });
const listQuery = z.object({
  environment: keySchema.optional(),
  flag: keySchema.optional(),
  status: z.enum(['running', 'stopped']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
const resultsQuery = z.object({
  // Results behind a failed sample ratio check stay hidden unless asked for.
  showMismatched: z.enum(['true', 'false']).default('false'),
});

export function experimentRoutes(ctx: Context) {
  return async (api: FastifyInstance): Promise<void> => {
    api.get('/projects/:project/experiments', async (request) => {
      const { project } = parse(projectParams, request.params, 'path');
      const q = parse(listQuery, request.query, 'query');
      const p = await getProject(ctx.db, project);
      const environmentId =
        q.environment === undefined
          ? undefined
          : (await getEnvironment(ctx.db, p.id, q.environment)).id;
      return {
        experiments: await listExperiments(ctx.db, p.id, {
          limit: q.limit,
          ...(environmentId === undefined ? {} : { environmentId }),
          ...(q.flag === undefined ? {} : { flag: q.flag }),
          ...(q.status === undefined ? {} : { status: q.status }),
        }),
      };
    });

    api.post(
      '/projects/:project/experiments',
      { config: { role: 'editor' } },
      async (request, reply) => {
        const { project } = parse(projectParams, request.params, 'path');
        const body = parse(experimentInput, request.body, 'experiment');
        const p = await getProject(ctx.db, project);
        const env = await getEnvironment(ctx.db, p.id, body.environment);
        const started = await startExperiment(
          {
            db: ctx.db,
            project: p,
            actor: actorOf(request),
            retention: ctx.config.changeRetention,
          },
          { id: env.id, key: env.key },
          body,
          ctx.now(),
        );
        return reply.status(201).send(started);
      },
    );

    api.get('/projects/:project/experiments/:experiment', async (request) => {
      const p = parse(experimentParams, request.params, 'path');
      const project = await getProject(ctx.db, p.project);
      return getExperiment(ctx.db, project.id, p.experiment);
    });

    api.post(
      '/projects/:project/experiments/:experiment/stop',
      { config: { role: 'editor' } },
      async (request) => {
        const p = parse(experimentParams, request.params, 'path');
        const project = await getProject(ctx.db, p.project);
        return stopExperiment(
          { db: ctx.db, project, actor: actorOf(request), retention: ctx.config.changeRetention },
          p.experiment,
          ctx.now(),
        );
      },
    );

    api.get('/projects/:project/experiments/:experiment/results', async (request) => {
      const p = parse(experimentParams, request.params, 'path');
      const q = parse(resultsQuery, request.query, 'query');
      const project = await getProject(ctx.db, p.project);
      return experimentResults(ctx.db, project.id, p.experiment, {
        showMismatched: q.showMismatched === 'true',
      });
    });
  };
}
