import { keySchema, prerequisiteSchema, ruleSchema, serveSchema, LIMITS } from '@flagship/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentUser, hasRole } from '../auth/guard.js';
import type { Context } from '../context.js';
import { parse } from '../errors.js';
import {
  applyChange,
  closeChange,
  getChangeRequest,
  listChangeRequests,
  proposeChange,
  proposeSegmentChange,
  rebaseChange,
  reviewChange,
} from '../services/changeRequests.js';
import type { Scope } from '../services/flags.js';
import { getEnvironment, getProject } from '../services/projects.js';
import { segmentBody } from './flags.js';

const text = z.string().max(4000);
const revision = z.strictObject({ revision: z.int().min(1) });

const proposalInput = z.strictObject({
  baseVersion: z.int().min(1),
  title: z.string().trim().min(1).max(200),
  description: text.optional(),
  enabled: z.boolean(),
  offVariant: keySchema,
  prerequisites: z.array(prerequisiteSchema).max(LIMITS.prerequisitesPerFlag),
  rules: z.array(ruleSchema).max(LIMITS.rulesPerFlag),
  fallthrough: serveSchema,
});

const segmentProposalInput = z.strictObject({
  baseVersion: z.int().min(0),
  title: z.string().trim().min(1).max(200),
  description: text.optional(),
  segment: z.strictObject(segmentBody).nullable(),
});

const reviewInput = z.strictObject({
  revision: z.int().min(1),
  decision: z.enum(['comment', 'approve', 'request_changes']),
  body: text.optional(),
});

const listQuery = z.object({
  status: z.enum(['open', 'applied', 'closed']).optional(),
  environment: keySchema.optional(),
  flag: keySchema.optional(),
  segment: keySchema.optional(),
  before: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const projectParams = z.object({ project: keySchema });
const requestParams = z.object({ project: keySchema, id: z.uuid() });
const targetParams = z.object({ project: keySchema, flag: keySchema, environment: keySchema });
const segmentParams = z.object({
  project: keySchema,
  environment: keySchema,
  segment: keySchema,
});

export function changeRequestRoutes(ctx: Context) {
  const scope = async (request: FastifyRequest, projectKey: string): Promise<Scope> => {
    const user = currentUser(request);
    return {
      db: ctx.db,
      project: await getProject(ctx.db, projectKey),
      actor: { id: user.id, name: user.name },
      retention: ctx.config.changeRetention,
    };
  };

  return async (api: FastifyInstance): Promise<void> => {
    api.get('/projects/:project/change-requests', async (request) => {
      const { project } = parse(projectParams, request.params, 'path');
      const q = parse(listQuery, request.query, 'query');
      const p = await getProject(ctx.db, project);
      const environmentId =
        q.environment === undefined
          ? undefined
          : (await getEnvironment(ctx.db, p.id, q.environment)).id;
      const requests = await listChangeRequests(ctx.db, p.id, { ...q, environmentId });
      const last = requests.at(-1);
      return {
        changeRequests: requests,
        next: requests.length === q.limit && last !== undefined ? last.id : null,
      };
    });

    api.post(
      '/projects/:project/flags/:flag/environments/:environment/change-requests',
      { config: { role: 'editor' } },
      async (request, reply) => {
        const p = parse(targetParams, request.params, 'path');
        const { baseVersion, title, description, ...config } = parse(
          proposalInput,
          request.body,
          'change request',
        );
        const s = await scope(request, p.project);
        const env = await getEnvironment(ctx.db, s.project.id, p.environment);
        const created = await proposeChange(s, { id: env.id, key: env.key }, p.flag, {
          baseVersion,
          title,
          description,
          config,
        });
        return reply.status(201).send(created);
      },
    );

    api.post(
      '/projects/:project/environments/:environment/segments/:segment/change-requests',
      { config: { role: 'editor' } },
      async (request, reply) => {
        const p = parse(segmentParams, request.params, 'path');
        const { segment, ...rest } = parse(segmentProposalInput, request.body, 'change request');
        const s = await scope(request, p.project);
        const env = await getEnvironment(ctx.db, s.project.id, p.environment);
        const created = await proposeSegmentChange(s, { id: env.id, key: env.key }, p.segment, {
          ...rest,
          segment:
            segment === null
              ? null
              : {
                  name: segment.name,
                  description: segment.description ?? '',
                  included: segment.included,
                  excluded: segment.excluded,
                  rules: segment.rules,
                },
        });
        return reply.status(201).send(created);
      },
    );

    api.get('/projects/:project/change-requests/:id', async (request) => {
      const p = parse(requestParams, request.params, 'path');
      const project = await getProject(ctx.db, p.project);
      return getChangeRequest(ctx.db, project.id, p.id);
    });

    api.post(
      '/projects/:project/change-requests/:id/reviews',
      { config: { role: 'editor' } },
      async (request, reply) => {
        const p = parse(requestParams, request.params, 'path');
        const body = parse(reviewInput, request.body, 'review');
        return reply
          .status(201)
          .send(await reviewChange(await scope(request, p.project), p.id, body));
      },
    );

    api.post(
      '/projects/:project/change-requests/:id/apply',
      { config: { role: 'editor' } },
      async (request) => {
        const p = parse(requestParams, request.params, 'path');
        const body = parse(revision, request.body, 'apply');
        return applyChange(await scope(request, p.project), p.id, body);
      },
    );

    api.post(
      '/projects/:project/change-requests/:id/rebase',
      { config: { role: 'editor' } },
      async (request) => {
        const p = parse(requestParams, request.params, 'path');
        const body = parse(revision, request.body, 'rebase');
        return rebaseChange(await scope(request, p.project), p.id, body);
      },
    );

    api.post(
      '/projects/:project/change-requests/:id/close',
      { config: { role: 'editor' } },
      async (request) => {
        const p = parse(requestParams, request.params, 'path');
        const body = parse(
          z.strictObject({ reason: text.optional() }),
          request.body ?? {},
          'close',
        );
        const s = await scope(request, p.project);
        return closeChange(s, p.id, hasRole(currentUser(request), 'admin'), body);
      },
    );
  };
}
