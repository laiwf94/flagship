import {
  FLAG_TYPES,
  keySchema,
  prerequisiteSchema,
  ruleSchema,
  segmentRuleSchema,
  serveSchema,
  variantSchema,
  LIMITS,
} from '@flagship/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentUser } from '../auth/guard.js';
import type { Context } from '../context.js';
import { parse } from '../errors.js';
import { listAudit } from '../services/audit.js';
import {
  archiveFlag,
  createFlag,
  getFlag,
  listFlags,
  restoreFlag,
  setKillSwitch,
  updateConfig,
  updateFlag,
  type Scope,
} from '../services/flags.js';
import { getEnvironment, getProject } from '../services/projects.js';
import { loadRuleset } from '../services/rulesets.js';
import {
  createSegment,
  deleteSegment,
  getSegment,
  listSegments,
  updateSegment,
} from '../services/segments.js';

const name = z.string().trim().min(1).max(100);
const description = z.string().max(LIMITS.descriptionLength);
const version = z.int().min(0);

const flagInput = z.strictObject({
  key: keySchema,
  name,
  description: description.optional(),
  type: z.enum(FLAG_TYPES),
  variants: z.array(variantSchema).min(2).max(LIMITS.variantsPerFlag).optional(),
  clientSide: z.boolean().optional(),
});

const flagPatch = z.strictObject({
  version,
  name: name.optional(),
  description: description.optional(),
  variants: z.array(variantSchema).min(2).max(LIMITS.variantsPerFlag).optional(),
  clientSide: z.boolean().optional(),
});

const configInput = z.strictObject({
  version,
  enabled: z.boolean(),
  offVariant: keySchema,
  prerequisites: z.array(prerequisiteSchema).max(LIMITS.prerequisitesPerFlag),
  rules: z.array(ruleSchema).max(LIMITS.rulesPerFlag),
  fallthrough: serveSchema,
});

const member = z.string().min(1).max(LIMITS.segmentMemberLength);
const segmentBody = {
  name,
  description: description.optional(),
  included: z.array(member).max(LIMITS.segmentMembers),
  excluded: z.array(member).max(LIMITS.segmentMembers),
  rules: z.array(segmentRuleSchema).max(LIMITS.segmentRules),
};
const segmentInput = z.strictObject({ key: keySchema, ...segmentBody });
const segmentPatch = z.strictObject({ version, ...segmentBody });

const listQuery = z.object({
  environment: keySchema,
  q: z.string().max(100).optional(),
  status: z.enum(['on', 'off', 'rollout', 'archived']).optional(),
  type: z.enum(FLAG_TYPES).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  after: keySchema.optional(),
});

const auditQuery = z.object({
  flag: keySchema.optional(),
  segment: keySchema.optional(),
  before: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const projectParams = z.object({ project: keySchema });
const flagParams = z.object({ project: keySchema, flag: keySchema });
const envParams = z.object({ project: keySchema, environment: keySchema });
const flagEnvParams = z.object({ project: keySchema, flag: keySchema, environment: keySchema });
const segmentParams = z.object({ project: keySchema, environment: keySchema, segment: keySchema });

export function flagRoutes(ctx: Context) {
  const scope = async (request: FastifyRequest, projectKey: string): Promise<Scope> => {
    const user = currentUser(request);
    return {
      db: ctx.db,
      project: await getProject(ctx.db, projectKey),
      actor: { id: user.id, name: user.name },
      retention: ctx.config.changeRetention,
    };
  };
  const env = async (projectId: string, key: string) => {
    const e = await getEnvironment(ctx.db, projectId, key);
    return { id: e.id, key: e.key };
  };

  return async (api: FastifyInstance): Promise<void> => {
    api.get('/projects/:project/flags', async (request) => {
      const { project } = parse(projectParams, request.params, 'path');
      const q = parse(listQuery, request.query, 'query');
      const p = await getProject(ctx.db, project);
      const e = await env(p.id, q.environment);
      return { flags: await listFlags(ctx.db, p.id, e.id, q) };
    });

    api.post('/projects/:project/flags', { config: { role: 'editor' } }, async (request, reply) => {
      const { project } = parse(projectParams, request.params, 'path');
      const body = parse(flagInput, request.body, 'flag');
      return reply.status(201).send(await createFlag(await scope(request, project), body));
    });

    api.get('/projects/:project/flags/:flag', async (request) => {
      const { project, flag } = parse(flagParams, request.params, 'path');
      const p = await getProject(ctx.db, project);
      return getFlag(ctx.db, p.id, flag);
    });

    api.put('/projects/:project/flags/:flag', { config: { role: 'editor' } }, async (request) => {
      const { project, flag } = parse(flagParams, request.params, 'path');
      const body = parse(flagPatch, request.body, 'flag');
      return updateFlag(await scope(request, project), flag, body);
    });

    api.post(
      '/projects/:project/flags/:flag/archive',
      { config: { role: 'editor' } },
      async (request) => {
        const { project, flag } = parse(flagParams, request.params, 'path');
        const body = parse(z.strictObject({ version }), request.body, 'archive');
        return archiveFlag(await scope(request, project), flag, body.version);
      },
    );

    api.post(
      '/projects/:project/flags/:flag/restore',
      { config: { role: 'editor' } },
      async (request) => {
        const { project, flag } = parse(flagParams, request.params, 'path');
        const body = parse(z.strictObject({ version }), request.body, 'restore');
        return restoreFlag(await scope(request, project), flag, body.version);
      },
    );

    api.put(
      '/projects/:project/flags/:flag/environments/:environment',
      { config: { role: 'editor' } },
      async (request) => {
        const p = parse(flagEnvParams, request.params, 'path');
        const { version: expected, ...config } = parse(configInput, request.body, 'targeting');
        const s = await scope(request, p.project);
        return updateConfig(s, await env(s.project.id, p.environment), p.flag, config, expected);
      },
    );

    api.post(
      '/projects/:project/flags/:flag/environments/:environment/kill-switch',
      { config: { role: 'editor' } },
      async (request) => {
        const p = parse(flagEnvParams, request.params, 'path');
        const body = parse(z.strictObject({ enabled: z.boolean() }), request.body, 'kill switch');
        const s = await scope(request, p.project);
        return setKillSwitch(s, await env(s.project.id, p.environment), p.flag, body.enabled);
      },
    );

    api.get('/projects/:project/environments/:environment/ruleset', async (request) => {
      const p = parse(envParams, request.params, 'path');
      const project = await getProject(ctx.db, p.project);
      return loadRuleset(ctx.db, (await env(project.id, p.environment)).id);
    });

    api.get('/projects/:project/environments/:environment/segments', async (request) => {
      const p = parse(envParams, request.params, 'path');
      const project = await getProject(ctx.db, p.project);
      return { segments: await listSegments(ctx.db, (await env(project.id, p.environment)).id) };
    });

    api.post(
      '/projects/:project/environments/:environment/segments',
      { config: { role: 'editor' } },
      async (request, reply) => {
        const p = parse(envParams, request.params, 'path');
        const body = parse(segmentInput, request.body, 'segment');
        const s = await scope(request, p.project);
        return reply
          .status(201)
          .send(await createSegment(s, await env(s.project.id, p.environment), body));
      },
    );

    api.get('/projects/:project/environments/:environment/segments/:segment', async (request) => {
      const p = parse(segmentParams, request.params, 'path');
      const project = await getProject(ctx.db, p.project);
      return getSegment(ctx.db, (await env(project.id, p.environment)).id, p.segment);
    });

    api.put(
      '/projects/:project/environments/:environment/segments/:segment',
      { config: { role: 'editor' } },
      async (request) => {
        const p = parse(segmentParams, request.params, 'path');
        const { version: expected, ...body } = parse(segmentPatch, request.body, 'segment');
        const s = await scope(request, p.project);
        return updateSegment(s, await env(s.project.id, p.environment), p.segment, body, expected);
      },
    );

    api.delete(
      '/projects/:project/environments/:environment/segments/:segment',
      { config: { role: 'editor' } },
      async (request, reply) => {
        const p = parse(segmentParams, request.params, 'path');
        const q = parse(
          z.object({ version: z.coerce.number().int().min(0) }),
          request.query,
          'query',
        );
        const s = await scope(request, p.project);
        await deleteSegment(s, await env(s.project.id, p.environment), p.segment, q.version);
        return reply.status(204).send();
      },
    );

    api.get('/projects/:project/audit', async (request) => {
      const { project } = parse(projectParams, request.params, 'path');
      const q = parse(auditQuery, request.query, 'query');
      const p = await getProject(ctx.db, project);
      const target =
        q.flag !== undefined
          ? { targetType: 'flag', targetKey: q.flag }
          : q.segment !== undefined
            ? { targetType: 'segment', targetKey: q.segment }
            : {};
      const entries = await listAudit(ctx.db, p.id, {
        ...target,
        before: q.before,
        limit: q.limit,
      });
      const last = entries.at(-1);
      return { entries, next: entries.length === q.limit && last !== undefined ? last.id : null };
    });
  };
}
