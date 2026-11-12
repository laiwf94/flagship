import {
  FLAG_TYPES,
  keySchema,
  prerequisiteSchema,
  rolloutPlanSchema,
  ruleSchema,
  segmentRuleSchema,
  serveSchema,
  variantSchema,
  LIMITS,
  STALE_AFTER_DAYS,
} from '@flagship/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Context } from '../context.js';
import { actorOf } from './note.js';
import { parse } from '../errors.js';
import { decodeCursor, searchAudit } from '../services/audit.js';
import { exposureSummary } from '../services/exposures.js';
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
import { staleFlags } from '../services/lifecycle.js';
import { getEnvironment, getProject } from '../services/projects.js';
import { planRestore, restoreEntry } from '../services/restore.js';
import { changeRolloutPlan, listRolloutPlans, startRolloutPlan } from '../services/rolloutPlans.js';
import { loadRuleset } from '../services/rulesets.js';
import {
  cancelSchedule,
  changeSchema,
  createSchedule,
  listSchedules,
} from '../services/schedules.js';
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
/** A segment's content, as created, edited or proposed in a change request. */
export const segmentBody = {
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

const auditQuery = z
  .object({
    flag: keySchema.optional(),
    segment: keySchema.optional(),
    actor: z.string().trim().min(1).max(100).optional(),
    q: z.string().trim().min(1).max(200).optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .refine((v) => v.flag === undefined || v.segment === undefined, {
    message: 'filter by a flag or a segment, not both',
    path: ['segment'],
  })
  .refine(
    (v) => v.from === undefined || v.to === undefined || Date.parse(v.from) < Date.parse(v.to),
    {
      message: 'must be after from',
      path: ['to'],
    },
  );

const restoreSide = z.enum(['before', 'after']);
const restoreQuery = z.object({ to: restoreSide.default('after') });
const restoreInput = z.strictObject({
  to: restoreSide,
  baseVersion: version,
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(4000).optional(),
});

const projectParams = z.object({ project: keySchema });
const entryParams = z.object({
  project: keySchema,
  id: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});
const flagParams = z.object({ project: keySchema, flag: keySchema });
const envParams = z.object({ project: keySchema, environment: keySchema });
const flagEnvParams = z.object({ project: keySchema, flag: keySchema, environment: keySchema });
const segmentParams = z.object({ project: keySchema, environment: keySchema, segment: keySchema });
const scheduleParams = flagEnvParams.extend({ id: z.uuid() });
const planParams = flagEnvParams.extend({
  id: z.uuid(),
  action: z.enum(['pause', 'resume', 'cancel']),
});
const scheduleInput = z.strictObject({
  runAt: z.iso.datetime({ offset: true }),
  change: changeSchema,
});

export function flagRoutes(ctx: Context) {
  const scope = async (request: FastifyRequest, projectKey: string): Promise<Scope> => {
    return {
      db: ctx.db,
      project: await getProject(ctx.db, projectKey),
      actor: actorOf(request),
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
      return { flags: await listFlags(ctx.db, p.id, e.id, q, ctx.now()) };
    });

    api.get('/projects/:project/environments/:environment/stale-flags', async (request) => {
      const { project, environment } = parse(envParams, request.params, 'path');
      const p = await getProject(ctx.db, project);
      const e = await env(p.id, environment);
      return {
        staleAfterDays: STALE_AFTER_DAYS,
        flags: await staleFlags(ctx.db, p.id, e.id, ctx.now()),
      };
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

    api.get(
      '/projects/:project/flags/:flag/environments/:environment/schedules',
      async (request) => {
        const p = parse(flagEnvParams, request.params, 'path');
        const project = await getProject(ctx.db, p.project);
        const e = await env(project.id, p.environment);
        return { schedules: await listSchedules(ctx.db, project.id, e.id, p.flag) };
      },
    );

    api.post(
      '/projects/:project/flags/:flag/environments/:environment/schedules',
      { config: { role: 'editor' } },
      async (request, reply) => {
        const p = parse(flagEnvParams, request.params, 'path');
        const body = parse(scheduleInput, request.body, 'scheduled change');
        const s = await scope(request, p.project);
        const created = await createSchedule(
          s,
          await env(s.project.id, p.environment),
          p.flag,
          { runAt: new Date(body.runAt), change: body.change },
          ctx.now(),
        );
        return reply.status(201).send(created);
      },
    );

    api.delete(
      '/projects/:project/flags/:flag/environments/:environment/schedules/:id',
      { config: { role: 'editor' } },
      async (request) => {
        const p = parse(scheduleParams, request.params, 'path');
        const s = await scope(request, p.project);
        return cancelSchedule(s, await env(s.project.id, p.environment), p.flag, p.id, ctx.now());
      },
    );

    api.get(
      '/projects/:project/flags/:flag/environments/:environment/rollout-plans',
      async (request) => {
        const p = parse(flagEnvParams, request.params, 'path');
        const project = await getProject(ctx.db, p.project);
        const e = await env(project.id, p.environment);
        return { plans: await listRolloutPlans(ctx.db, project.id, e.id, p.flag) };
      },
    );

    api.post(
      '/projects/:project/flags/:flag/environments/:environment/rollout-plans',
      { config: { role: 'editor' } },
      async (request, reply) => {
        const p = parse(flagEnvParams, request.params, 'path');
        const body = parse(rolloutPlanSchema, request.body, 'rollout plan');
        const s = await scope(request, p.project);
        const started = await startRolloutPlan(
          s,
          await env(s.project.id, p.environment),
          p.flag,
          body,
          ctx.now(),
        );
        return reply.status(201).send(started);
      },
    );

    api.post(
      '/projects/:project/flags/:flag/environments/:environment/rollout-plans/:id/:action',
      { config: { role: 'editor' } },
      async (request) => {
        const p = parse(planParams, request.params, 'path');
        const s = await scope(request, p.project);
        return changeRolloutPlan(
          s,
          await env(s.project.id, p.environment),
          p.flag,
          p.id,
          p.action,
          ctx.now(),
        );
      },
    );

    api.get('/projects/:project/flags/:flag/exposures', async (request) => {
      const p = parse(flagParams, request.params, 'path');
      const q = parse(
        z.object({
          environment: keySchema,
          hours: z.coerce.number().int().min(1).max(720).default(24),
        }),
        request.query,
        'query',
      );
      const project = await getProject(ctx.db, p.project);
      const e = await env(project.id, q.environment);
      return exposureSummary(ctx.db, e.id, p.flag, q.hours, ctx.now());
    });

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
      return searchAudit(ctx.db, p.id, {
        ...target,
        actor: q.actor,
        text: q.q,
        from: q.from === undefined ? undefined : new Date(q.from),
        to: q.to === undefined ? undefined : new Date(q.to),
        after: q.cursor === undefined ? undefined : decodeCursor(q.cursor),
        limit: q.limit,
      });
    });

    api.get('/projects/:project/audit/:id/restore', async (request) => {
      const p = parse(entryParams, request.params, 'path');
      const q = parse(restoreQuery, request.query, 'query');
      const project = await getProject(ctx.db, p.project);
      return planRestore(ctx.db, project.id, p.id, q.to);
    });

    api.post(
      '/projects/:project/audit/:id/restore',
      { config: { role: 'editor' } },
      async (request, reply) => {
        const p = parse(entryParams, request.params, 'path');
        const body = parse(restoreInput, request.body, 'restore');
        const result = await restoreEntry(await scope(request, p.project), p.id, body);
        return reply.status(result.outcome === 'proposed' ? 201 : 200).send(result);
      },
    );
  };
}
