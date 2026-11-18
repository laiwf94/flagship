import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { keySchema } from '@flagship/core';
import { sql } from 'kysely';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Db } from '../db/database.js';
import type { EgressPolicy } from '../egress.js';
import type { WebhookDeliveryStatus } from '../db/schema.js';
import { AppError, notFound } from '../errors.js';
import type { ChangeEvent, DurableHandler } from '../events.js';
import type { Metrics } from '../metrics.js';
import { SecretKeyError, type SecretBox } from '../secretbox.js';
import { recordAudit, type Actor } from './audit.js';

/**
 * Webhooks: signed HTTP callbacks for a project's change events.
 *
 * - Secrets are generated here, shown once, and stored sealed with
 *   AES-256-GCM (see secretbox.ts), bound to the webhook's id.
 * - The `webhooks` consumer on the event bus is a transactional outbox: it
 *   writes one delivery per matching webhook in the transaction that advances
 *   its position, so a committed change gets exactly one delivery per webhook
 *   and a rolled-back one gets none.
 * - A worker on every instance claims due deliveries with SKIP LOCKED,
 *   pushing `next_attempt_at` forward as a lease so a delivery whose instance
 *   died is picked up again once the lease runs out. Each attempt has a hard
 *   deadline, follows no redirects, and reads at most 64 KiB of the response.
 *   Failures retry with jittered exponential backoff for 24 hours, and every
 *   attempt is recorded.
 */

export const WEBHOOKS_CONSUMER = 'webhooks';
/** NOTIFY channel that wakes the delivery workers when the outbox has new rows. */
export const WEBHOOKS_CHANNEL = 'flagship_webhooks';

export const SECRET_PREFIX = 'whsec_';
export const MAX_WEBHOOKS_PER_PROJECT = 50;
/** Payloads over this drop `before` and `after` and say so with `truncated: true`. */
export const MAX_PAYLOAD_BYTES = 256 * 1024;
/** Response bytes read before the connection is closed. */
export const RESPONSE_READ_LIMIT = 64 * 1024;
/** Response bytes kept in the attempt log. */
export const RESPONSE_EXCERPT_BYTES = 1024;
/** How long a delivery keeps retrying, from when it was created. */
export const RETRY_WINDOW_MS = 24 * 3_600_000;
/** How long the previous secret keeps signing after a rotation. */
export const PREVIOUS_SECRET_TTL_MS = 24 * 3_600_000;
/** Delay after the nth failed attempt, before jitter; the last repeats until the window closes. */
export const BACKOFF_SECONDS = [10, 30, 60, 300, 900, 1800, 3600] as const;
const MAX_BACKOFF_MS = 3_600_000;
const MAX_ERROR = 500;

export const SIGNATURE_HEADER = 'flagship-signature';
export const DELIVERY_HEADER = 'flagship-delivery';
export const EVENT_HEADER = 'flagship-event';
export const ATTEMPT_HEADER = 'flagship-attempt';
const USER_AGENT = 'flagship-webhooks/1';

// ---------------------------------------------------------------------------
// Inputs

const EVENT_PATTERN = /^(\*|[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*(\.\*)?)$/;

/** True for a URL a webhook may target: http or https, no credentials, no fragment. */
export function isWebhookUrl(text: string): boolean {
  if (text.length > 2000) return false;
  const url = URL.parse(text);
  return (
    url !== null &&
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    url.username === '' &&
    url.password === '' &&
    url.hash === '' &&
    !text.includes('#')
  );
}

const webhookUrl = z
  .string()
  .trim()
  .refine(
    isWebhookUrl,
    'must be an http or https URL of at most 2000 characters, ' +
      'without credentials or a fragment',
  );
const name = z.string().trim().min(1).max(100);
const events = z
  .array(
    z
      .string()
      .max(100)
      .regex(
        EVENT_PATTERN,
        'must be *, an action such as flag.kill_switch, or a prefix such as flag.*',
      ),
  )
  .min(1)
  .max(50);

export const webhookInput = z.strictObject({
  name,
  url: webhookUrl,
  environment: keySchema.nullable().optional(),
  events: events.optional(),
  enabled: z.boolean().optional(),
});
export type WebhookInput = z.output<typeof webhookInput>;

export const webhookPatch = z
  .strictObject({
    name: name.optional(),
    url: webhookUrl.optional(),
    environment: keySchema.nullable().optional(),
    events: events.optional(),
    enabled: z.boolean().optional(),
  })
  .refine((p) => Object.keys(p).length > 0, 'change at least one field');
export type WebhookPatch = z.output<typeof webhookPatch>;

/** Whether an action matches any of the patterns: `*`, exact, or `prefix.*`. */
export function matchesEvent(patterns: readonly string[], action: string): boolean {
  return patterns.some((p) => {
    if (p === '*') return true;
    if (p.endsWith('.*')) return action.startsWith(p.slice(0, -1));
    return p === action;
  });
}

/** The URL with any query string hidden, for audit entries. */
export function maskUrl(text: string): string {
  const url = URL.parse(text);
  if (url === null) return text;
  return `${url.origin}${url.pathname}${url.search === '' ? '' : '?…'}`;
}

// ---------------------------------------------------------------------------
// Signing

/**
 * The signature header: `t=<unix seconds>,v1=<hex>` with one `v1` per secret
 * (two during a rotation's overlap). Each is HMAC-SHA256, keyed with the whole
 * secret string, over `<t>.<body>`. Receivers accept the request when any
 * `v1` matches and `t` is recent.
 */
export function signatureHeader(secrets: readonly string[], at: Date, body: string): string {
  const t = Math.floor(at.getTime() / 1000);
  const parts = [`t=${t}`];
  for (const secret of secrets) {
    parts.push(`v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`);
  }
  return parts.join(',');
}

function newSecret(): string {
  return `${SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
}

const context = (id: string) => `webhook:${id}`;

// ---------------------------------------------------------------------------
// Management

export interface WebhookView {
  id: string;
  name: string;
  url: string;
  /** Null when the webhook hears every environment in the project. */
  environment: string | null;
  events: string[];
  enabled: boolean;
  /** Until when the secret before the last rotation still signs, if it does. */
  previousSecretExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  name: string;
  url: string;
  environment_key: string | null;
  events: string[];
  enabled: boolean;
  previous_secret_expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function view(r: Row, now: Date): WebhookView {
  const previous = r.previous_secret_expires_at;
  return {
    id: r.id,
    name: r.name,
    url: r.url,
    environment: r.environment_key,
    events: r.events,
    enabled: r.enabled,
    previousSecretExpiresAt: previous !== null && previous > now ? previous.toISOString() : null,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

function rows(db: Db, projectId: string) {
  return db
    .selectFrom('webhooks')
    .leftJoin('environments', 'environments.id', 'webhooks.environment_id')
    .select([
      'webhooks.id',
      'webhooks.name',
      'webhooks.url',
      'environments.key as environment_key',
      'webhooks.events',
      'webhooks.enabled',
      'webhooks.previous_secret_expires_at',
      'webhooks.created_at',
      'webhooks.updated_at',
    ])
    .where('webhooks.project_id', '=', projectId);
}

export interface WebhookDeps {
  db: Db;
  secrets: SecretBox | undefined;
  now: () => Date;
  /** Checks a URL's literal address up front; deliveries check every resolved address. */
  egress: EgressPolicy;
}

/** Refuses a URL whose literal address (or localhost name) could never be delivered to. */
function checkTarget(d: WebhookDeps, url: string): void {
  const parsed = URL.parse(url);
  const why = parsed === null ? null : d.egress.urlRefusal(parsed);
  if (why !== null) {
    throw new AppError('invalid_argument', 'invalid webhook', [{ path: 'url', message: why }]);
  }
}

function box(d: WebhookDeps): SecretBox {
  if (d.secrets === undefined) {
    throw new AppError(
      'failed_precondition',
      'webhooks need FLAGSHIP_SECRET_KEY set on the server to encrypt their signing secrets',
    );
  }
  return d.secrets;
}

const UUID = z.uuid();

async function findRow(db: Db, projectId: string, id: string): Promise<Row> {
  const row = UUID.safeParse(id).success
    ? await rows(db, projectId).where('webhooks.id', '=', id).executeTakeFirst()
    : undefined;
  if (row === undefined) throw notFound('webhook');
  return row;
}

export async function listWebhooks(d: WebhookDeps, projectId: string): Promise<WebhookView[]> {
  const list = await rows(d.db, projectId)
    .orderBy('webhooks.created_at')
    .orderBy('webhooks.id')
    .execute();
  const now = d.now();
  return list.map((r) => view(r, now));
}

export async function getWebhook(
  d: WebhookDeps,
  projectId: string,
  id: string,
): Promise<WebhookView> {
  return view(await findRow(d.db, projectId, id), d.now());
}

async function environmentId(
  db: Db,
  projectId: string,
  key: string | null,
): Promise<string | null> {
  if (key === null) return null;
  const env = await db
    .selectFrom('environments')
    .select('id')
    .where('project_id', '=', projectId)
    .where('key', '=', key)
    .executeTakeFirst();
  if (env === undefined) throw notFound(`environment "${key}"`);
  return env.id;
}

function auditShape(w: WebhookView) {
  return {
    name: w.name,
    url: maskUrl(w.url),
    environment: w.environment,
    events: w.events,
    enabled: w.enabled,
  };
}

export async function createWebhook(
  d: WebhookDeps,
  projectId: string,
  input: WebhookInput,
  actor: Actor,
): Promise<WebhookView & { secret: string }> {
  const sealer = box(d);
  checkTarget(d, input.url);
  const id = randomUUID();
  const secret = newSecret();
  const sealed = sealer.seal(secret, context(id));
  return d.db.transaction().execute(async (trx) => {
    // Serialises creations in a project so the limit holds.
    await trx.selectFrom('projects').select('id').where('id', '=', projectId).forUpdate().execute();
    const count = await trx
      .selectFrom('webhooks')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('project_id', '=', projectId)
      .executeTakeFirstOrThrow();
    if (count.n >= MAX_WEBHOOKS_PER_PROJECT) {
      throw new AppError(
        'resource_exhausted',
        `a project can have at most ${MAX_WEBHOOKS_PER_PROJECT} webhooks`,
      );
    }
    await trx
      .insertInto('webhooks')
      .values({
        id,
        project_id: projectId,
        environment_id: await environmentId(trx, projectId, input.environment ?? null),
        name: input.name,
        url: input.url,
        events: input.events ?? ['*'],
        enabled: input.enabled ?? true,
        secret_key_id: sealed.keyId,
        secret: sealed.value,
        created_by: actor.id,
      })
      .execute();
    const created = view(await findRow(trx, projectId, id), d.now());
    await recordAudit(trx, {
      projectId,
      actor,
      action: 'webhook.create',
      targetType: 'webhook',
      targetKey: created.name,
      after: auditShape(created),
    });
    return { ...created, secret };
  });
}

/** Marks a webhook's pending deliveries failed, when it is disabled. */
async function cancelPending(db: Db, webhookId: string, now: Date, why: string): Promise<void> {
  await db
    .updateTable('webhook_deliveries')
    .set({ status: 'failed', completed_at: now, last_error: why })
    .where('webhook_id', '=', webhookId)
    .where('status', '=', 'pending')
    .execute();
}

export async function updateWebhook(
  d: WebhookDeps,
  projectId: string,
  id: string,
  patch: WebhookPatch,
  actor: Actor,
): Promise<WebhookView> {
  if (patch.url !== undefined) checkTarget(d, patch.url);
  return d.db.transaction().execute(async (trx) => {
    const locked = UUID.safeParse(id).success
      ? await trx
          .selectFrom('webhooks')
          .select('id')
          .where('id', '=', id)
          .where('project_id', '=', projectId)
          .forUpdate()
          .executeTakeFirst()
      : undefined;
    if (locked === undefined) throw notFound('webhook');
    const before = view(await findRow(trx, projectId, id), d.now());
    await trx
      .updateTable('webhooks')
      .set({
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.url === undefined ? {} : { url: patch.url }),
        ...(patch.environment === undefined
          ? {}
          : { environment_id: await environmentId(trx, projectId, patch.environment) }),
        ...(patch.events === undefined ? {} : { events: patch.events }),
        ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
        updated_at: d.now(),
      })
      .where('id', '=', id)
      .execute();
    if (patch.enabled === false && before.enabled) {
      await cancelPending(trx, id, d.now(), 'webhook disabled');
    }
    const after = view(await findRow(trx, projectId, id), d.now());
    await recordAudit(trx, {
      projectId,
      actor,
      action: 'webhook.update',
      targetType: 'webhook',
      targetKey: after.name,
      before: auditShape(before),
      after: auditShape(after),
    });
    return after;
  });
}

export async function deleteWebhook(
  d: WebhookDeps,
  projectId: string,
  id: string,
  actor: Actor,
): Promise<void> {
  await d.db.transaction().execute(async (trx) => {
    const before = view(await findRow(trx, projectId, id), d.now());
    await trx.deleteFrom('webhooks').where('id', '=', id).execute();
    await recordAudit(trx, {
      projectId,
      actor,
      action: 'webhook.delete',
      targetType: 'webhook',
      targetKey: before.name,
      before: auditShape(before),
    });
  });
}

/**
 * Replaces the signing secret. The old one keeps signing alongside it for 24
 * hours, so receivers can switch without dropping deliveries.
 */
export async function rotateWebhookSecret(
  d: WebhookDeps,
  projectId: string,
  id: string,
  actor: Actor,
): Promise<WebhookView & { secret: string }> {
  const sealer = box(d);
  const secret = newSecret();
  return d.db.transaction().execute(async (trx) => {
    const row = UUID.safeParse(id).success
      ? await trx
          .selectFrom('webhooks')
          .select(['secret', 'secret_key_id'])
          .where('id', '=', id)
          .where('project_id', '=', projectId)
          .forUpdate()
          .executeTakeFirst()
      : undefined;
    if (row === undefined) throw notFound('webhook');
    const now = d.now();
    // The old secret moves across only if this key can still open it; one
    // sealed under a lost key is useless to keep.
    let previous: Buffer | null = null;
    try {
      sealer.open({ keyId: row.secret_key_id, value: row.secret }, context(id));
      previous = row.secret;
    } catch (err) {
      if (!(err instanceof SecretKeyError)) throw err;
    }
    const sealed = sealer.seal(secret, context(id));
    await trx
      .updateTable('webhooks')
      .set({
        secret: sealed.value,
        secret_key_id: sealed.keyId,
        previous_secret: previous,
        previous_secret_expires_at:
          previous === null ? null : new Date(now.getTime() + PREVIOUS_SECRET_TTL_MS),
        updated_at: now,
      })
      .where('id', '=', id)
      .execute();
    const after = view(await findRow(trx, projectId, id), now);
    await recordAudit(trx, {
      projectId,
      actor,
      action: 'webhook.secret_rotate',
      targetType: 'webhook',
      targetKey: after.name,
      after: { previousSecretExpiresAt: after.previousSecretExpiresAt },
    });
    return { ...after, secret };
  });
}

// ---------------------------------------------------------------------------
// The outbox

/** The JSON body of a delivery. */
export interface WebhookPayload {
  /** Stable per event, the same for every webhook that receives it. */
  id: string;
  type: string;
  createdAt: string;
  project: string;
  environment: string | null;
  target: { type: string; key: string };
  actor: { id: string | null; name: string };
  reason: string | null;
  link: string | null;
  before: unknown;
  after: unknown;
  /** Set when `before` and `after` were left out to keep the payload under 256 KiB. */
  truncated?: true;
}

export function buildPayload(
  e: ChangeEvent,
  projectKey: string,
  environmentKey: string | null,
): string {
  const payload: WebhookPayload = {
    id: `evt_${e.id}`,
    type: e.action,
    createdAt: e.at.toISOString(),
    project: projectKey,
    environment: environmentKey,
    target: { type: e.targetType, key: e.targetKey },
    actor: e.actor,
    reason: e.reason,
    link: e.link,
    before: e.before,
    after: e.after,
  };
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) <= MAX_PAYLOAD_BYTES) return body;
  return JSON.stringify({ ...payload, before: null, after: null, truncated: true });
}

/**
 * The bus consumer: one delivery per event and matching enabled webhook,
 * written in the transaction that advances the consumer.
 */
export function webhookOutbox(now: () => Date): DurableHandler {
  return async (trx, events) => {
    const projectIds = [
      ...new Set(events.flatMap((e) => (e.projectId === null ? [] : [e.projectId]))),
    ];
    if (projectIds.length === 0) return;
    const hooks = await trx
      .selectFrom('webhooks')
      .innerJoin('projects', 'projects.id', 'webhooks.project_id')
      .select([
        'webhooks.id',
        'webhooks.project_id',
        'webhooks.environment_id',
        'webhooks.events',
        'projects.key as project_key',
      ])
      .where('webhooks.project_id', 'in', projectIds)
      .where('webhooks.enabled', '=', true)
      .execute();
    if (hooks.length === 0) return;
    const envIds = [
      ...new Set(events.flatMap((e) => (e.environmentId === null ? [] : [e.environmentId]))),
    ];
    const envKeys = new Map(
      envIds.length === 0
        ? []
        : (
            await trx
              .selectFrom('environments')
              .select(['id', 'key'])
              .where('id', 'in', envIds)
              .execute()
          ).map((r) => [r.id, r.key] as const),
    );
    const at = now();
    const giveUp = new Date(at.getTime() + RETRY_WINDOW_MS);
    const values = [];
    for (const e of events) {
      let body: string | undefined;
      for (const h of hooks) {
        if (h.project_id !== e.projectId) continue;
        if (h.environment_id !== null && h.environment_id !== e.environmentId) continue;
        if (!matchesEvent(h.events, e.action)) continue;
        body ??= buildPayload(
          e,
          h.project_key,
          e.environmentId === null ? null : (envKeys.get(e.environmentId) ?? null),
        );
        values.push({
          webhook_id: h.id,
          event_id: e.id,
          event_type: e.action,
          payload: body,
          next_attempt_at: at,
          give_up_at: giveUp,
        });
      }
    }
    if (values.length === 0) return;
    for (let i = 0; i < values.length; i += 500) {
      await trx
        .insertInto('webhook_deliveries')
        .values(values.slice(i, i + 500))
        .execute();
    }
    await sql`SELECT pg_notify(${WEBHOOKS_CHANNEL}, '')`.execute(trx);
  };
}

// ---------------------------------------------------------------------------
// Sending

export interface OutgoingRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface AttemptResult {
  /** HTTP status, or null when no response arrived. */
  status: number | null;
  error: string | null;
  /** The start of the response body. */
  response: string | null;
  /** Whether the response was longer than what was read or kept. */
  truncated: boolean;
  durationMs: number;
  /** From Retry-After on a 429 or 503. */
  retryAfterMs: number | null;
}

export interface SendOptions {
  timeoutMs: number;
  /** Which addresses may be connected to; without one, any may. */
  egress?: EgressPolicy;
  agents?: { http: http.Agent; https: https.Agent };
  signal?: AbortSignal;
}

/** Parses Retry-After: delay seconds or an HTTP date. */
export function parseRetryAfter(value: string | undefined, now: Date): number | null {
  if (value === undefined) return null;
  const v = value.trim();
  if (/^\d{1,10}$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now.getTime());
}

const clean = (text: string, max: number) =>
  // eslint-disable-next-line no-control-regex
  text.replace(/\u0000/g, '').slice(0, max);

/**
 * POSTs one delivery. Never throws: every outcome, including a timeout, a
 * refused connection or an oversized response, comes back as a result. The
 * deadline covers connecting, sending and reading the response. Redirects
 * are not followed.
 */
export function send(req: OutgoingRequest, o: SendOptions): Promise<AttemptResult> {
  const started = performance.now();
  const url = URL.parse(req.url);
  const refused = url === null ? 'invalid URL' : (o.egress?.urlRefusal(url) ?? null);
  if (url === null || refused !== null) {
    return Promise.resolve({
      status: null,
      error: refused,
      response: null,
      truncated: false,
      durationMs: 0,
      retryAfterMs: null,
    });
  }
  return new Promise((resolve) => {
    let done = false;
    let status: number | null = null;
    let retryAfterMs: number | null = null;
    const kept: Buffer[] = [];
    let keptBytes = 0;
    let received = 0;
    let truncated = false;

    const finish = (error: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      const response =
        kept.length === 0
          ? null
          : clean(Buffer.concat(kept).toString('utf8'), RESPONSE_EXCERPT_BYTES);
      resolve({
        status,
        error: error === null ? null : clean(error, MAX_ERROR),
        response,
        truncated,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        retryAfterMs,
      });
    };

    const secure = url.protocol === 'https:';
    const request = (secure ? https : http).request(url, {
      method: 'POST',
      headers: { ...req.headers, 'content-length': String(Buffer.byteLength(req.body)) },
      // Every address is checked as it is resolved, so the one connected to is the one checked.
      ...(o.egress === undefined ? {} : { lookup: o.egress.lookup }),
      ...(o.agents === undefined ? {} : { agent: secure ? o.agents.https : o.agents.http }),
    });
    const timer = setTimeout(() => {
      request.destroy(new Error(`timed out after ${o.timeoutMs} ms`));
    }, o.timeoutMs);
    const onAbort = () => {
      request.destroy(new Error('the server is shutting down'));
    };
    if (o.signal?.aborted === true) onAbort();
    else o.signal?.addEventListener('abort', onAbort, { once: true });

    request.on('error', (err) => {
      finish(err.message === '' ? 'request failed' : err.message);
    });
    request.on('response', (res) => {
      status = res.statusCode ?? null;
      if (status === 429 || status === 503) {
        retryAfterMs = parseRetryAfter(res.headers['retry-after'], new Date());
      }
      res.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (keptBytes < RESPONSE_EXCERPT_BYTES) {
          const part = chunk.subarray(0, RESPONSE_EXCERPT_BYTES - keptBytes);
          kept.push(part);
          keptBytes += part.length;
          if (part.length < chunk.length) truncated = true;
        } else truncated = true;
        if (received > RESPONSE_READ_LIMIT) {
          // Enough: the status is what counts, and the rest isn't worth the memory or time.
          finish(null);
          res.destroy();
        }
      });
      res.on('end', () => {
        finish(null);
      });
      res.on('error', (err) => {
        finish(err.message);
      });
      res.on('close', () => {
        finish(res.complete ? null : 'connection closed before the response ended');
      });
    });
    request.end(req.body);
  });
}

/** Whether an attempt counts as delivered. */
export function delivered(r: AttemptResult): boolean {
  return r.error === null && r.status !== null && r.status >= 200 && r.status < 300;
}

/** Why a finished attempt failed, for the delivery's last_error. */
function failure(r: AttemptResult): string | null {
  if (delivered(r)) return null;
  if (r.error !== null) return r.error;
  if (r.status !== null && r.status >= 300 && r.status < 400) {
    return `HTTP ${r.status}: redirects are not followed`;
  }
  return `HTTP ${r.status ?? '?'}`;
}

/**
 * Delay before the next attempt after `attempt` failed: the schedule in
 * BACKOFF_SECONDS with ±10% jitter, or longer if the receiver asked with
 * Retry-After, capped at an hour.
 */
export function backoffMs(
  attempt: number,
  retryAfterMs: number | null,
  random: () => number = Math.random,
): number {
  const base = BACKOFF_SECONDS[Math.min(attempt, BACKOFF_SECONDS.length) - 1] ?? 3600;
  const jittered = Math.round(base * 1000 * (0.9 + 0.2 * random()));
  return Math.min(Math.max(jittered, retryAfterMs ?? 0), MAX_BACKOFF_MS);
}

// ---------------------------------------------------------------------------
// The worker

interface Claimed {
  id: string;
  webhook_id: string;
  event_type: string;
  payload: string;
  attempts: number;
  give_up_at: Date;
  url: string;
  secret_key_id: string;
  secret: Buffer;
  previous_secret: Buffer | null;
  previous_secret_expires_at: Date | null;
}

export interface WebhookWorkerOptions {
  db: Db;
  secrets: SecretBox | undefined;
  metrics: Metrics;
  logger: Logger;
  now: () => Date;
  timeoutMs: number;
  concurrency: number;
  pollMs: number;
  /** Refuses private, loopback and link-local receivers unless allow-listed. */
  egress: EgressPolicy;
  random?: () => number;
}

export class WebhookWorker {
  private readonly inFlight = new Set<Promise<void>>();
  private filling: Promise<void> | null = null;
  private again = false;
  private closed = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly abort = new AbortController();
  private readonly agents: { http: http.Agent; https: https.Agent };

  constructor(private readonly o: WebhookWorkerOptions) {
    const agent = { keepAlive: true, maxSockets: o.concurrency, maxTotalSockets: o.concurrency };
    this.agents = { http: new http.Agent(agent), https: new https.Agent(agent) };
  }

  start(): void {
    this.timer = setInterval(() => {
      this.wake();
    }, this.o.pollMs);
    this.timer.unref();
    this.wake();
  }

  /** Claims due deliveries up to the concurrency limit; coalesces overlapping calls. */
  wake(): void {
    if (this.closed) return;
    if (this.filling !== null) {
      this.again = true;
      return;
    }
    this.filling = this.fill().finally(() => {
      this.filling = null;
    });
  }

  /** Resolves once nothing is due and nothing is in flight. */
  async drain(): Promise<void> {
    for (;;) {
      if (this.filling !== null) await this.filling;
      if (this.inFlight.size > 0) {
        await Promise.allSettled([...this.inFlight]);
        continue;
      }
      const claimed = await this.claim(this.o.concurrency);
      if (claimed.length === 0 && this.inFlight.size === 0 && this.filling === null) return;
      for (const c of claimed) this.track(c);
    }
  }

  /** Stops claiming, cuts in-flight requests short (they are retried) and waits for them. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.abort.abort();
    if (this.filling !== null) await this.filling;
    await Promise.allSettled([...this.inFlight]);
    this.agents.http.destroy();
    this.agents.https.destroy();
  }

  private async fill(): Promise<void> {
    do {
      this.again = false;
      const free = this.o.concurrency - this.inFlight.size;
      if (free <= 0) return;
      let claimed: Claimed[];
      try {
        claimed = await this.claim(free);
      } catch (err) {
        this.o.logger.warn({ err }, 'claiming webhook deliveries failed');
        return;
      }
      for (const c of claimed) this.track(c);
      if (claimed.length === free) this.again = true;
    } while (this.again && !this.closed);
  }

  private track(c: Claimed): void {
    const p: Promise<void> = this.attempt(c)
      .catch((err: unknown) => {
        // The lease runs out and the delivery is tried again.
        this.o.logger.error({ err, delivery: c.id }, 'recording a webhook attempt failed');
      })
      .finally(() => {
        this.inFlight.delete(p);
        this.wake();
      });
    this.inFlight.add(p);
  }

  /**
   * Takes up to `limit` due deliveries of enabled webhooks, counting the
   * attempt and moving `next_attempt_at` past the attempt's deadline: that is
   * the lease. If this instance dies mid-attempt, the delivery comes due again.
   */
  private async claim(limit: number): Promise<Claimed[]> {
    const now = this.o.now();
    const lease = new Date(now.getTime() + this.o.timeoutMs + 30_000);
    const result = await sql<Claimed>`
      UPDATE webhook_deliveries d
      SET attempts = d.attempts + 1, next_attempt_at = ${lease}
      FROM (
        SELECT wd.id FROM webhook_deliveries wd
        JOIN webhooks wh ON wh.id = wd.webhook_id
        WHERE wd.status = 'pending' AND wd.next_attempt_at <= ${now} AND wh.enabled
        ORDER BY wd.next_attempt_at
        LIMIT ${limit}
        FOR UPDATE OF wd SKIP LOCKED
      ) due, webhooks w
      WHERE d.id = due.id AND w.id = d.webhook_id
      RETURNING d.id, d.webhook_id, d.event_type, d.payload::text AS payload, d.attempts,
        d.give_up_at, w.url, w.secret_key_id, w.secret, w.previous_secret,
        w.previous_secret_expires_at`.execute(this.o.db);
    return result.rows;
  }

  /** The secrets to sign with: the current one, and the previous one during its overlap. */
  private secretsFor(c: Claimed, now: Date): string[] {
    if (this.o.secrets === undefined) {
      throw new SecretKeyError('FLAGSHIP_SECRET_KEY is not set');
    }
    const box = this.o.secrets;
    const list = [box.open({ keyId: c.secret_key_id, value: c.secret }, context(c.webhook_id))];
    if (
      c.previous_secret !== null &&
      c.previous_secret_expires_at !== null &&
      c.previous_secret_expires_at > now
    ) {
      list.push(
        box.open({ keyId: c.secret_key_id, value: c.previous_secret }, context(c.webhook_id)),
      );
    }
    return list;
  }

  private async attempt(c: Claimed): Promise<void> {
    const startedAt = this.o.now();
    let secrets: string[];
    try {
      secrets = this.secretsFor(c, startedAt);
    } catch (err) {
      if (!(err instanceof SecretKeyError)) throw err;
      await this.record(c, startedAt, {
        status: null,
        error: `cannot open the signing secret: ${err.message}`,
        response: null,
        truncated: false,
        durationMs: 0,
        retryAfterMs: null,
      });
      return;
    }
    const result = await send(
      {
        url: c.url,
        headers: {
          'content-type': 'application/json',
          'user-agent': USER_AGENT,
          [DELIVERY_HEADER]: c.id,
          [EVENT_HEADER]: c.event_type,
          [ATTEMPT_HEADER]: String(c.attempts),
          [SIGNATURE_HEADER]: signatureHeader(secrets, startedAt, c.payload),
        },
        body: c.payload,
      },
      {
        timeoutMs: this.o.timeoutMs,
        agents: this.agents,
        signal: this.abort.signal,
        egress: this.o.egress,
      },
    );
    this.o.metrics.webhookDuration.observe(result.durationMs / 1000);
    await this.record(c, startedAt, result);
  }

  private async record(c: Claimed, startedAt: Date, r: AttemptResult): Promise<void> {
    const now = this.o.now();
    const ok = delivered(r);
    const why = failure(r);
    let status: WebhookDeliveryStatus = 'succeeded';
    let next = now;
    if (!ok) {
      next = new Date(now.getTime() + backoffMs(c.attempts, r.retryAfterMs, this.o.random));
      status = next >= c.give_up_at ? 'failed' : 'pending';
    }
    const recorded = await this.o.db.transaction().execute(async (trx) => {
      const inserted = await trx
        .insertInto('webhook_attempts')
        .values({
          delivery_id: c.id,
          attempt: c.attempts,
          started_at: startedAt,
          duration_ms: r.durationMs,
          status: r.status,
          error: r.error,
          response: r.response,
          response_truncated: r.truncated,
        })
        .onConflict((oc) => oc.doNothing())
        .returning('attempt')
        .executeTakeFirst();
      if (inserted === undefined) return false;
      const updated = await trx
        .updateTable('webhook_deliveries')
        .set({
          status,
          next_attempt_at: next,
          completed_at: status === 'pending' ? null : now,
          last_attempt_at: startedAt,
          last_status: r.status,
          last_error: why === null ? null : clean(why, MAX_ERROR),
        })
        // Only while this attempt still holds the delivery.
        .where('id', '=', c.id)
        .where('attempts', '=', c.attempts)
        .where('status', '=', 'pending')
        .executeTakeFirst();
      return updated.numUpdatedRows > 0n;
    });
    const result = !recorded
      ? 'stale'
      : ok
        ? 'succeeded'
        : status === 'failed'
          ? 'failed'
          : 'retry';
    this.o.metrics.webhookDeliveries.inc({ result });
    if (result === 'failed') {
      this.o.logger.warn(
        { delivery: c.id, webhook: c.webhook_id, attempts: c.attempts, error: why },
        'webhook delivery gave up',
      );
    }
  }
}

/** Housekeeping: removes finished deliveries (and their attempts) past the retention period. */
export function pruneWebhookDeliveries(db: Db, retentionDays: number) {
  return async (now: Date): Promise<number> => {
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
    const result = await sql`
      DELETE FROM webhook_deliveries WHERE id IN (
        SELECT id FROM webhook_deliveries
        WHERE status <> 'pending' AND completed_at < ${cutoff}
        LIMIT 5000
      )`.execute(db);
    return Number(result.numAffectedRows ?? 0n);
  };
}
