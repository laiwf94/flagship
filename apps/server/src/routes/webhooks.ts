import type { FastifyInstance } from 'fastify';
import type { Context } from '../context.js';
import { parse } from '../errors.js';
import { getProject } from '../services/projects.js';
import {
  bulkReplayInput,
  createWebhook,
  deleteWebhook,
  deliveryQuery,
  getDelivery,
  getWebhook,
  listDeliveries,
  listWebhooks,
  replayDeliveries,
  replayDelivery,
  rotateWebhookSecret,
  updateWebhook,
  webhookInput,
  webhookPatch,
  type WebhookDeps,
} from '../services/webhooks.js';
import { actorOf } from './note.js';
import { projectParams } from './projects.js';
import { z } from 'zod';

const webhookParams = projectParams.extend({ id: z.string().max(64) });
const deliveryParams = webhookParams.extend({ delivery: z.string().max(64) });

/** Webhook management: admins only, since a webhook sends change details off the server. */
export function webhookRoutes(ctx: Context) {
  const deps: WebhookDeps = {
    db: ctx.db,
    secrets: ctx.secrets,
    now: ctx.now,
    egress: ctx.egress,
  };
  const project = async (params: unknown) => {
    const p = parse(projectParams, params, 'path');
    return (await getProject(ctx.db, p.project)).id;
  };
  const target = async (params: unknown) => {
    const p = parse(webhookParams, params, 'path');
    return { projectId: (await getProject(ctx.db, p.project)).id, id: p.id };
  };
  const delivery = async (params: unknown) => {
    const p = parse(deliveryParams, params, 'path');
    return {
      projectId: (await getProject(ctx.db, p.project)).id,
      id: p.id,
      deliveryId: p.delivery,
    };
  };
  const admin = { config: { role: 'admin' as const } };

  return async (api: FastifyInstance): Promise<void> => {
    api.get('/projects/:project/webhooks', admin, async (request) => ({
      webhooks: await listWebhooks(deps, await project(request.params)),
    }));

    api.post('/projects/:project/webhooks', admin, async (request, reply) => {
      const actor = actorOf(request);
      const projectId = await project(request.params);
      const body = parse(webhookInput, request.body, 'webhook');
      return reply.status(201).send(await createWebhook(deps, projectId, body, actor));
    });

    api.get('/projects/:project/webhooks/:id', admin, async (request) => {
      const { projectId, id } = await target(request.params);
      return getWebhook(deps, projectId, id);
    });

    api.patch('/projects/:project/webhooks/:id', admin, async (request) => {
      const actor = actorOf(request);
      const { projectId, id } = await target(request.params);
      const body = parse(webhookPatch, request.body, 'webhook');
      return updateWebhook(deps, projectId, id, body, actor);
    });

    api.delete('/projects/:project/webhooks/:id', admin, async (request, reply) => {
      const actor = actorOf(request);
      const { projectId, id } = await target(request.params);
      await deleteWebhook(deps, projectId, id, actor);
      return reply.status(204).send();
    });

    api.post('/projects/:project/webhooks/:id/secret', admin, async (request) => {
      const actor = actorOf(request);
      const { projectId, id } = await target(request.params);
      return rotateWebhookSecret(deps, projectId, id, actor);
    });

    api.get('/projects/:project/webhooks/:id/deliveries', admin, async (request) => {
      const { projectId, id } = await target(request.params);
      const q = parse(deliveryQuery, request.query, 'query');
      return listDeliveries(deps, projectId, id, q);
    });

    api.get('/projects/:project/webhooks/:id/deliveries/:delivery', admin, async (request) => {
      const { projectId, id, deliveryId } = await delivery(request.params);
      return getDelivery(deps, projectId, id, deliveryId);
    });

    api.post(
      '/projects/:project/webhooks/:id/deliveries/:delivery/replay',
      admin,
      async (request, reply) => {
        const actor = actorOf(request);
        const { projectId, id, deliveryId } = await delivery(request.params);
        return reply.status(202).send(await replayDelivery(deps, projectId, id, deliveryId, actor));
      },
    );

    api.post('/projects/:project/webhooks/:id/replay', admin, async (request, reply) => {
      const actor = actorOf(request);
      const { projectId, id } = await target(request.params);
      const body = parse(bulkReplayInput, request.body, 'replay');
      return reply.status(202).send(await replayDeliveries(deps, projectId, id, body, actor));
    });
  };
}
