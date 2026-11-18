import { createHmac, randomBytes } from 'node:crypto';
import http, { type IncomingHttpHeaders } from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testApp, type TestApp } from '../../test/app.js';
import { PASSWORD, signIn, userWithRole, type Client } from '../../test/session.js';
import { EgressPolicy } from '../egress.js';
import { SecretBox } from '../secretbox.js';
import { recordAudit } from './audit.js';
import {
  BACKOFF_SECONDS,
  backoffMs,
  buildPayload,
  createWebhook,
  delivered,
  isWebhookUrl,
  maskUrl,
  matchesEvent,
  MAX_PAYLOAD_BYTES,
  MAX_WEBHOOKS_PER_PROJECT,
  parseRetryAfter,
  pruneWebhookDeliveries,
  RESPONSE_EXCERPT_BYTES,
  send,
  signatureHeader,
  type WebhookPayload,
} from './webhooks.js';

// ---------------------------------------------------------------------------
// A receiver on loopback that records requests and answers as told.

interface Received {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

type Responder = (req: Received, res: http.ServerResponse) => void;

class Receiver {
  readonly received: Received[] = [];
  respond: Responder = (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
  };
  private readonly server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const r = {
        path: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      };
      this.received.push(r);
      this.respond(r, res);
    });
  });

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
  }

  url(path = '/hook'): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}${path}`;
  }

  at(path: string): Received[] {
    return this.received.filter((r) => r.path === path);
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }
}

function verify(header: string | string[] | undefined, body: string, secret: string): boolean {
  const parts = String(header).split(',');
  const t = parts.find((p) => p.startsWith('t='))?.slice(2);
  const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return parts.includes(`v1=${expected}`);
}

// ---------------------------------------------------------------------------

const KEY = randomBytes(32);
const P = '/api/projects/default';
let t: TestApp;
let admin: Client;
let editor: Client;
let receiver: Receiver;
let clock = new Date('2030-03-01T12:00:00Z');
let projectId: string;

const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};

/** Runs the bus and the worker until `check` holds. */
async function settle(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    await t.app.events.drain();
    await t.app.webhooks.drain();
    if (await check()) return;
    if (Date.now() - start > ms) throw new Error('webhook not delivered in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function hook(body: Record<string, unknown>): Promise<{ id: string; secret: string }> {
  const res = await admin.request('POST', `${P}/webhooks`, body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

async function kill(flag: string, environment: string, enabled = true): Promise<void> {
  const res = await editor.request(
    'POST',
    `${P}/flags/${flag}/environments/${environment}/kill-switch`,
    { enabled },
  );
  expect(res.statusCode, res.body).toBe(200);
}

async function flag(key: string): Promise<void> {
  const res = await editor.request('POST', `${P}/flags`, { key, name: key, type: 'boolean' });
  expect(res.statusCode, res.body).toBe(201);
}

async function deliveries(webhookId: string) {
  return t.db
    .selectFrom('webhook_deliveries')
    .selectAll()
    .where('webhook_id', '=', webhookId)
    .orderBy('created_at')
    .execute();
}

async function attempts(deliveryId: string) {
  return t.db
    .selectFrom('webhook_attempts')
    .selectAll()
    .where('delivery_id', '=', deliveryId)
    .orderBy('attempt')
    .execute();
}

beforeAll(async () => {
  receiver = new Receiver();
  await receiver.start();
  t = await testApp(
    {
      bootstrapAdmin: { email: 'root@example.com', password: PASSWORD },
      secretKey: KEY,
      webhookTimeoutMs: 500,
      webhookPollMs: 60_000,
      // The test receivers listen on loopback.
      webhookAllowedTargets: ['127.0.0.1'],
      sessionIdleMinutes: 10_080 * 52,
      sessionMaxHours: 24 * 400,
    },
    { now: () => clock },
  );
  admin = await signIn(t.app.server, 'root@example.com');
  editor = await userWithRole(t.app.server, t.db, 'eddie@example.com', 'editor');
  projectId = (
    await t.db
      .selectFrom('projects')
      .select('id')
      .where('key', '=', 'default')
      .executeTakeFirstOrThrow()
  ).id;
});
afterAll(async () => {
  await t.close();
  await receiver.close();
});
beforeEach(() => {
  receiver.respond = (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
  };
});

describe('webhook management', () => {
  it('is for admins, shows the secret once, seals it at rest and audits without it', async () => {
    const denied = await editor.request('POST', `${P}/webhooks`, {
      name: 'x',
      url: receiver.url(),
    });
    expect(denied.statusCode).toBe(403);
    expect((await editor.request('GET', `${P}/webhooks`)).statusCode).toBe(403);

    const created = await admin.request('POST', `${P}/webhooks`, {
      name: 'Ops',
      url: `${receiver.url('/ops')}?token=abc`,
      environment: 'production',
      events: ['flag.kill_switch'],
      enabled: false,
    });
    expect(created.statusCode, created.body).toBe(201);
    const body = created.json<{ id: string; secret: string }>();
    expect(body).toMatchObject({
      name: 'Ops',
      environment: 'production',
      events: ['flag.kill_switch'],
      enabled: false,
      previousSecretExpiresAt: null,
    });
    expect(body.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);

    const listed = await admin.request('GET', `${P}/webhooks`);
    expect(listed.body).not.toContain(body.secret);
    expect(listed.json<{ webhooks: unknown[] }>().webhooks).toContainEqual(
      expect.objectContaining({ id: body.id, url: `${receiver.url('/ops')}?token=abc` }),
    );
    const one = await admin.request('GET', `${P}/webhooks/${body.id}`);
    expect(one.json()).not.toHaveProperty('secret');

    const row = await t.db
      .selectFrom('webhooks')
      .select(['secret', 'secret_key_id'])
      .where('id', '=', body.id)
      .executeTakeFirstOrThrow();
    expect(row.secret_key_id).toBe(new SecretBox(KEY).keyId);
    expect(row.secret.includes(Buffer.from(body.secret))).toBe(false);
    expect(row.secret.includes(Buffer.from(body.secret.slice(6)))).toBe(false);
    expect(
      new SecretBox(KEY).open(
        { keyId: row.secret_key_id, value: row.secret },
        `webhook:${body.id}`,
      ),
    ).toBe(body.secret);

    const patched = await admin.request('PATCH', `${P}/webhooks/${body.id}`, {
      name: 'Ops pager',
      environment: null,
      events: ['flag.*'],
    });
    expect(patched.json()).toMatchObject({
      name: 'Ops pager',
      environment: null,
      events: ['flag.*'],
    });

    const audit = await t.db
      .selectFrom('audit_log')
      .select(['action', 'target_key', 'before', 'after'])
      .where('target_type', '=', 'webhook')
      .orderBy('id')
      .execute();
    expect(JSON.stringify(audit)).not.toContain(body.secret);
    expect(JSON.stringify(audit)).not.toContain('token=abc');
    expect(audit.map((a) => a.action)).toEqual(['webhook.create', 'webhook.update']);
    expect(audit[0]?.after).toMatchObject({ url: `${receiver.url('/ops')}?…` });

    expect((await admin.request('DELETE', `${P}/webhooks/${body.id}`)).statusCode).toBe(204);
    expect((await admin.request('GET', `${P}/webhooks/${body.id}`)).statusCode).toBe(404);
    expect((await admin.request('DELETE', `${P}/webhooks/${body.id}`)).statusCode).toBe(404);
    expect((await admin.request('GET', `${P}/webhooks/not-a-uuid`)).statusCode).toBe(404);
    expect(
      (await admin.request('PATCH', `${P}/webhooks/not-a-uuid`, { name: 'x' })).statusCode,
    ).toBe(404);
    expect((await admin.request('POST', `${P}/webhooks/not-a-uuid/secret`)).statusCode).toBe(404);
  });

  it('validates input', async () => {
    const bad = async (body: unknown, status = 400) => {
      const res = await admin.request('POST', `${P}/webhooks`, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(status);
    };
    await bad({ name: 'x', url: 'ftp://example.com/hook' });
    await bad({ name: 'x', url: 'https://user:pass@example.com/hook' });
    await bad({ name: 'x', url: 'https://example.com/hook#frag' });
    await bad({ name: 'x', url: `https://example.com/${'a'.repeat(2000)}` });
    await bad({ name: 'x', url: 'https://example.com', events: [] });
    await bad({ name: 'x', url: 'https://example.com', events: ['FLAG'] });
    await bad({ name: 'x', url: 'https://example.com', events: ['flag.**'] });
    await bad({ name: '', url: 'https://example.com' });
    await bad({ name: 'x', url: 'https://example.com', extra: 1 });
    await bad({ name: 'x', url: 'https://example.com', environment: 'nowhere' }, 404);
    const res = await admin.request(
      'PATCH',
      `${P}/webhooks/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`,
      {},
    );
    expect(res.statusCode).toBe(400);
    expect((await admin.request('GET', '/api/projects/nope/webhooks')).statusCode).toBe(404);
  });

  it('needs FLAGSHIP_SECRET_KEY', async () => {
    const deps = { db: t.db, secrets: undefined, now: () => clock, egress: new EgressPolicy() };
    await expect(
      createWebhook(
        deps,
        projectId,
        { name: 'x', url: 'https://example.com' },
        { id: null, name: 't' },
      ),
    ).rejects.toMatchObject({ code: 'failed_precondition' });
  });

  it(`allows at most ${MAX_WEBHOOKS_PER_PROJECT} per project`, async () => {
    expect(
      (await admin.request('POST', '/api/projects', { key: 'many', name: 'Many' })).statusCode,
    ).toBe(201);
    const many = await t.db
      .selectFrom('projects')
      .select('id')
      .where('key', '=', 'many')
      .executeTakeFirstOrThrow();
    const deps = {
      db: t.db,
      secrets: new SecretBox(KEY),
      now: () => clock,
      egress: new EgressPolicy(),
    };
    for (let i = 0; i < MAX_WEBHOOKS_PER_PROJECT; i++) {
      await createWebhook(
        deps,
        many.id,
        // Disabled, so they never send anything off this machine.
        { name: `h${i}`, url: 'https://example.com', enabled: false },
        { id: null, name: 't' },
      );
    }
    const res = await admin.request('POST', '/api/projects/many/webhooks', {
      name: 'one too many',
      url: 'https://example.com',
    });
    expect(res.statusCode).toBe(429);
    expect(
      (await admin.request('GET', '/api/projects/many/webhooks')).json<{ webhooks: unknown[] }>()
        .webhooks,
    ).toHaveLength(MAX_WEBHOOKS_PER_PROJECT);
  });
});

describe('webhook delivery', () => {
  it('delivers each matching committed change once, signed with a timestamp', async () => {
    const prod = await hook({
      name: 'prod kills',
      url: receiver.url('/prod'),
      environment: 'production',
      events: ['flag.kill_switch'],
    });
    const all = await hook({ name: 'everything', url: receiver.url('/all'), events: ['flag.*'] });

    await flag('checkout');
    await kill('checkout', 'development');
    await kill('checkout', 'production');
    await settle(() => receiver.at('/prod').length >= 1 && receiver.at('/all').length >= 3);

    const [got] = receiver.at('/prod');
    expect(receiver.at('/prod')).toHaveLength(1);
    expect(got?.headers).toMatchObject({
      'content-type': 'application/json',
      'user-agent': 'flagship-webhooks/1',
      'flagship-event': 'flag.kill_switch',
      'flagship-attempt': '1',
    });
    expect(got?.headers['flagship-delivery']).toMatch(/^[0-9a-f-]{36}$/);
    const signature = String(got?.headers['flagship-signature']);
    expect(signature).toMatch(
      new RegExp(`^t=${Math.floor(clock.getTime() / 1000)},v1=[0-9a-f]{64}$`),
    );
    expect(verify(signature, got?.body ?? '', prod.secret)).toBe(true);
    expect(verify(signature, got?.body ?? '', all.secret)).toBe(false);
    expect(verify(signature, `${got?.body ?? ''} `, prod.secret)).toBe(false);

    const payload = JSON.parse(got?.body ?? '{}') as WebhookPayload;
    expect(payload).toMatchObject({
      type: 'flag.kill_switch',
      project: 'default',
      environment: 'production',
      target: { type: 'flag', key: 'checkout' },
      actor: { name: 'eddie' },
    });
    expect(payload.id).toMatch(/^evt_\d+$/);

    const everything = receiver.at('/all').map((r) => JSON.parse(r.body) as WebhookPayload);
    expect(everything.map((p) => [p.type, p.environment])).toEqual([
      ['flag.create', null],
      ['flag.kill_switch', 'development'],
      ['flag.kill_switch', 'production'],
    ]);
    // The same event has the same id for every webhook that gets it.
    expect(everything[2]?.id).toBe(payload.id);

    const [d] = await deliveries(prod.id);
    expect(d).toMatchObject({
      status: 'succeeded',
      attempts: 1,
      last_status: 200,
      last_error: null,
    });
    expect(d?.completed_at).toEqual(clock);
    expect(await attempts(d?.id ?? '')).toEqual([
      expect.objectContaining({
        attempt: 1,
        status: 200,
        error: null,
        response: 'ok',
        response_truncated: false,
      }),
    ]);
    expect(t.app.metrics.webhookDeliveries.get({ result: 'succeeded' })).toBeGreaterThanOrEqual(4);

    await admin.request('DELETE', `${P}/webhooks/${prod.id}`);
    await admin.request('DELETE', `${P}/webhooks/${all.id}`);
    expect(await deliveries(prod.id)).toEqual([]);
  });

  it('writes nothing for a change that rolled back', async () => {
    const h = await hook({ name: 'rollback', url: receiver.url('/rb'), events: ['flag.*'] });
    await t.db
      .transaction()
      .execute(async (trx) => {
        await recordAudit(trx, {
          projectId,
          actor: { id: null, name: 'test' },
          action: 'flag.kill_switch',
          targetType: 'flag',
          targetKey: 'rolled-back',
        });
        throw new Error('abort');
      })
      .catch(() => undefined);
    await recordAudit(t.db, {
      projectId,
      actor: { id: null, name: 'test' },
      action: 'flag.kill_switch',
      targetType: 'flag',
      targetKey: 'committed',
    });
    // Events outside any project go nowhere.
    await recordAudit(t.db, {
      projectId: null,
      actor: { id: null, name: 't' },
      action: 'user.create',
      targetType: 'user',
      targetKey: 'u',
    });
    await settle(() => receiver.at('/rb').length >= 1);
    expect(
      receiver.at('/rb').map((r) => (JSON.parse(r.body) as WebhookPayload).target.key),
    ).toEqual(['committed']);
    await admin.request('DELETE', `${P}/webhooks/${h.id}`);
  });

  it('retries failures with backoff, honours Retry-After, and logs every attempt', async () => {
    let n = 0;
    receiver.respond = (req, res) => {
      if (req.path !== '/flaky') return void res.end();
      n++;
      if (n <= 2) res.writeHead(500).end('boom');
      else if (n === 3) res.writeHead(503, { 'retry-after': '120' }).end();
      else res.writeHead(204).end();
    };
    const h = await hook({
      name: 'flaky',
      url: receiver.url('/flaky'),
      events: ['flag.kill_switch'],
    });
    await flag('flaky');
    await kill('flaky', 'production');
    await settle(() => receiver.at('/flaky').length === 1);

    const due = async () => (await deliveries(h.id))[0];
    let d = await due();
    expect(d).toMatchObject({
      status: 'pending',
      attempts: 1,
      last_status: 500,
      last_error: 'HTTP 500',
    });
    const after = (from: Date, d2: Date | undefined) =>
      ((d2?.getTime() ?? 0) - from.getTime()) / 1000;
    expect(after(clock, d?.next_attempt_at)).toBeGreaterThanOrEqual(BACKOFF_SECONDS[0] * 0.9);
    expect(after(clock, d?.next_attempt_at)).toBeLessThanOrEqual(BACKOFF_SECONDS[0] * 1.1);

    // Not due yet: nothing happens.
    advance(5000);
    await t.app.webhooks.drain();
    expect(receiver.at('/flaky')).toHaveLength(1);

    advance(6000);
    await settle(() => receiver.at('/flaky').length === 2);
    d = await due();
    expect(after(clock, d?.next_attempt_at)).toBeGreaterThanOrEqual(BACKOFF_SECONDS[1] * 0.9);
    expect(after(clock, d?.next_attempt_at)).toBeLessThanOrEqual(BACKOFF_SECONDS[1] * 1.1);

    advance(33_000);
    await settle(() => receiver.at('/flaky').length === 3);
    d = await due();
    expect(d?.last_status).toBe(503);
    expect(after(clock, d?.next_attempt_at)).toBe(120);

    advance(120_000);
    await settle(() => receiver.at('/flaky').length === 4);
    d = await due();
    expect(d).toMatchObject({
      status: 'succeeded',
      attempts: 4,
      last_status: 204,
      last_error: null,
    });

    const requests = receiver.at('/flaky');
    expect(requests.map((r) => r.headers['flagship-attempt'])).toEqual(['1', '2', '3', '4']);
    expect(new Set(requests.map((r) => r.headers['flagship-delivery'])).size).toBe(1);
    // Each attempt is signed afresh, at its own time, over the same body.
    expect(new Set(requests.map((r) => r.headers['flagship-signature'])).size).toBe(4);
    expect(new Set(requests.map((r) => r.body)).size).toBe(1);
    for (const r of requests)
      expect(verify(r.headers['flagship-signature'], r.body, h.secret)).toBe(true);

    const log = await attempts(d?.id ?? '');
    expect(log.map((a) => [a.attempt, a.status, a.response])).toEqual([
      [1, 500, 'boom'],
      [2, 500, 'boom'],
      [3, 503, null],
      [4, 204, null],
    ]);
    expect(t.app.metrics.webhookDeliveries.get({ result: 'retry' })).toBeGreaterThanOrEqual(3);
    await admin.request('DELETE', `${P}/webhooks/${h.id}`);
  });

  it('keeps retrying for 24 hours, then gives up', async () => {
    receiver.respond = (_req, res) => {
      res.writeHead(502).end();
    };
    const h = await hook({
      name: 'down',
      url: receiver.url('/down'),
      events: ['flag.kill_switch'],
    });
    await flag('down');
    await kill('down', 'production');
    await settle(() => receiver.at('/down').length === 1);
    const created = clock.getTime();
    const failedBefore = t.app.metrics.webhookDeliveries.get({ result: 'failed' });
    for (let i = 0; i < 100; i++) {
      const [d] = await deliveries(h.id);
      if (d?.status !== 'pending') break;
      clock = d.next_attempt_at;
      await settle(() => receiver.at('/down').length === d.attempts + 1);
    }
    const [d] = await deliveries(h.id);
    expect(d?.status).toBe('failed');
    expect(d?.completed_at).toEqual(clock);
    expect(d?.give_up_at.getTime()).toBe(created + 24 * 3_600_000);
    // 7 scheduled delays add up to about 1.9 hours, then hourly to the 24-hour mark.
    expect(d?.attempts).toBeGreaterThanOrEqual(26);
    expect(d?.attempts).toBeLessThanOrEqual(31);
    expect(clock.getTime() - created).toBeLessThan(24 * 3_600_000);
    expect(receiver.at('/down')).toHaveLength(d?.attempts ?? 0);
    expect(t.app.metrics.webhookDeliveries.get({ result: 'failed' })).toBe(failedBefore + 1);
    expect(t.logs.some((l) => l.includes('webhook delivery gave up'))).toBe(true);

    // Nothing further, however long we wait.
    advance(48 * 3_600_000);
    await settle(() => true);
    expect(receiver.at('/down')).toHaveLength(d?.attempts ?? 0);
    await admin.request('DELETE', `${P}/webhooks/${h.id}`);
  });

  it('records refused connections and timeouts as failed attempts', async () => {
    const closed = http.createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((r) => closed.close(r));
    const refused = await hook({
      name: 'refused',
      url: `http://127.0.0.1:${port}/x`,
      events: ['flag.kill_switch'],
    });
    receiver.respond = () => {
      // Never answers.
    };
    const slow = await hook({
      name: 'slow',
      url: receiver.url('/slow'),
      events: ['flag.kill_switch'],
    });
    await flag('unreachable');
    await kill('unreachable', 'production');
    const done = async () =>
      (await deliveries(refused.id))[0]?.attempts === 1 &&
      (await deliveries(slow.id))[0]?.attempts === 1;
    await settle(done);
    const [r] = await deliveries(refused.id);
    expect(r).toMatchObject({ status: 'pending', last_status: null });
    expect(r?.last_error).toMatch(/ECONNREFUSED/);
    const [s] = await deliveries(slow.id);
    expect(s?.last_error).toBe('timed out after 500 ms');
    const [a] = await attempts(s?.id ?? '');
    expect(a?.duration_ms).toBeGreaterThanOrEqual(450);
    for (const id of [refused.id, slow.id]) await admin.request('DELETE', `${P}/webhooks/${id}`);
  });

  it('cancels pending deliveries when a webhook is disabled', async () => {
    receiver.respond = (_req, res) => {
      res.writeHead(500).end();
    };
    const h = await hook({
      name: 'disable me',
      url: receiver.url('/dis'),
      events: ['flag.kill_switch'],
    });
    await flag('disable');
    await kill('disable', 'production');
    await settle(() => receiver.at('/dis').length === 1);
    expect((await deliveries(h.id))[0]?.status).toBe('pending');
    const res = await admin.request('PATCH', `${P}/webhooks/${h.id}`, { enabled: false });
    expect(res.json()).toMatchObject({ enabled: false });
    expect((await deliveries(h.id))[0]).toMatchObject({
      status: 'failed',
      last_error: 'webhook disabled',
    });
    // Nothing new while disabled.
    await kill('disable', 'production', false);
    advance(3_600_000);
    await settle(() => true);
    expect(receiver.at('/dis')).toHaveLength(1);
    expect(await deliveries(h.id)).toHaveLength(1);
    await admin.request('DELETE', `${P}/webhooks/${h.id}`);
  });

  it('signs with the old and new secrets for 24 hours after a rotation', async () => {
    const h = await hook({
      name: 'rotate',
      url: receiver.url('/rot'),
      events: ['flag.kill_switch'],
    });
    await flag('rotate');
    const rotated = await admin.request('POST', `${P}/webhooks/${h.id}/secret`);
    expect(rotated.statusCode).toBe(200);
    const { secret, previousSecretExpiresAt } = rotated.json<{
      secret: string;
      previousSecretExpiresAt: string;
    }>();
    expect(secret).not.toBe(h.secret);
    expect(previousSecretExpiresAt).toBe(new Date(clock.getTime() + 24 * 3_600_000).toISOString());

    await kill('rotate', 'production');
    await settle(() => receiver.at('/rot').length === 1);
    const [first] = receiver.at('/rot');
    expect(String(first?.headers['flagship-signature']).match(/v1=/g)).toHaveLength(2);
    expect(verify(first?.headers['flagship-signature'], first?.body ?? '', h.secret)).toBe(true);
    expect(verify(first?.headers['flagship-signature'], first?.body ?? '', secret)).toBe(true);

    advance(24 * 3_600_000 + 1000);
    await kill('rotate', 'production', false);
    await settle(() => receiver.at('/rot').length === 2);
    const second = receiver.at('/rot')[1];
    expect(String(second?.headers['flagship-signature']).match(/v1=/g)).toHaveLength(1);
    expect(verify(second?.headers['flagship-signature'], second?.body ?? '', secret)).toBe(true);
    expect(verify(second?.headers['flagship-signature'], second?.body ?? '', h.secret)).toBe(false);
    expect((await admin.request('GET', `${P}/webhooks/${h.id}`)).json()).toMatchObject({
      previousSecretExpiresAt: null,
    });

    // A secret the server can no longer open is not carried over by a rotation.
    await t.db
      .updateTable('webhooks')
      .set({ secret_key_id: 'ffffffffffffffff' })
      .where('id', '=', h.id)
      .execute();
    const again = await admin.request('POST', `${P}/webhooks/${h.id}/secret`);
    expect(again.json()).toMatchObject({ previousSecretExpiresAt: null });
    await admin.request('DELETE', `${P}/webhooks/${h.id}`);
  });

  it('retries, without sending, when the signing secret cannot be opened', async () => {
    const h = await hook({
      name: 'lost key',
      url: receiver.url('/lost'),
      events: ['flag.kill_switch'],
    });
    await t.db
      .updateTable('webhooks')
      .set({ secret_key_id: 'ffffffffffffffff' })
      .where('id', '=', h.id)
      .execute();
    await flag('lost');
    await kill('lost', 'production');
    await settle(async () => (await deliveries(h.id))[0]?.attempts === 1);
    const [d] = await deliveries(h.id);
    expect(d).toMatchObject({ status: 'pending', last_status: null });
    expect(d?.last_error).toMatch(
      /^cannot open the signing secret: sealed under key ffffffffffffffff/,
    );
    expect(receiver.at('/lost')).toHaveLength(0);
    await admin.request('DELETE', `${P}/webhooks/${h.id}`);
  });

  it('picks a delivery up again when the attempt holding it was lost', async () => {
    const h = await hook({
      name: 'lease',
      url: receiver.url('/lease'),
      events: ['flag.kill_switch'],
    });
    const insert = (attemptsSoFar: number, next: Date) =>
      t.db
        .insertInto('webhook_deliveries')
        .values({
          webhook_id: h.id,
          event_id: 1,
          event_type: 'flag.kill_switch',
          payload: JSON.stringify({ id: 'evt_1' }),
          attempts: attemptsSoFar,
          next_attempt_at: next,
          give_up_at: new Date(clock.getTime() + 24 * 3_600_000),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
    // Claimed by an instance that died: attempt 1 counted, its lease running.
    const lost = await insert(1, new Date(clock.getTime() + 30_500));
    await t.app.webhooks.drain();
    expect(receiver.at('/lease')).toHaveLength(0);
    advance(31_000);
    await settle(() => receiver.at('/lease').length === 1);
    expect(receiver.at('/lease')[0]?.headers['flagship-attempt']).toBe('2');
    expect((await attempts(lost.id)).map((a) => a.attempt)).toEqual([2]);

    // A result for an attempt someone else already recorded changes nothing.
    const stale = await insert(0, clock);
    await t.db
      .insertInto('webhook_attempts')
      .values({ delivery_id: stale.id, attempt: 1, started_at: clock, duration_ms: 1, status: 500 })
      .execute();
    const before = t.app.metrics.webhookDeliveries.get({ result: 'stale' });
    await t.app.webhooks.drain();
    expect(t.app.metrics.webhookDeliveries.get({ result: 'stale' })).toBe(before + 1);
    const row = await t.db
      .selectFrom('webhook_deliveries')
      .selectAll()
      .where('id', '=', stale.id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'pending', attempts: 1, last_status: null });
    await admin.request('DELETE', `${P}/webhooks/${h.id}`);
  });

  it('prunes finished deliveries after the retention period', async () => {
    const h = await hook({
      name: 'prune',
      url: receiver.url('/prune'),
      events: ['flag.kill_switch'],
    });
    await flag('prune');
    await kill('prune', 'production');
    await settle(() => receiver.at('/prune').length === 1);
    const pending = await t.db
      .insertInto('webhook_deliveries')
      .values({
        webhook_id: h.id,
        event_id: 2,
        event_type: 'x',
        payload: '{}',
        next_attempt_at: new Date(clock.getTime() + 3_600_000),
        give_up_at: new Date(clock.getTime() + 3_600_000),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const prune = pruneWebhookDeliveries(t.db, 30);
    await prune(new Date(clock.getTime() + 29 * 86_400_000));
    expect(await deliveries(h.id)).toHaveLength(2);
    expect(await prune(new Date(clock.getTime() + 31 * 86_400_000))).toBeGreaterThanOrEqual(1);
    expect((await deliveries(h.id)).map((d) => d.id)).toEqual([pending.id]);
    const left = await t.db
      .selectFrom('webhook_deliveries')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('status', '<>', 'pending')
      .executeTakeFirstOrThrow();
    expect(left.n).toBe(0);
    await admin.request('DELETE', `${P}/webhooks/${h.id}`);
  });

  it('reports its counters on /metrics', async () => {
    const res = await t.app.server.inject({ url: '/metrics', remoteAddress: '127.0.0.1' });
    expect(res.body).toContain('flagship_webhook_attempts_total{result="succeeded"}');
    expect(res.body).toContain('flagship_webhook_attempt_duration_seconds_count');
    const consumer = await sql<{ name: string }>`SELECT name FROM event_consumers`.execute(t.db);
    expect(consumer.rows.map((r) => r.name)).toContain('webhooks');
  });
});

describe('sending one attempt', () => {
  const servers: http.Server[] = [];
  async function serve(handler: http.RequestListener): Promise<string> {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  }
  afterAll(async () => {
    for (const s of servers) {
      s.closeAllConnections();
      await new Promise((r) => s.close(r));
    }
  });
  const req = (url: string) => ({
    url,
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });

  it('stops reading a huge response and keeps only its start', async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200);
      const chunk = Buffer.alloc(64 * 1024, 'a');
      chunk[0] = 0; // A NUL, which Postgres text can't hold.
      let sent = 0;
      const pump = () => {
        while (sent < 10 * 1024 * 1024) {
          sent += chunk.length;
          if (!res.write(chunk)) {
            res.once('drain', pump);
            return;
          }
        }
        res.end();
      };
      pump();
    });
    const r = await send(req(url), { timeoutMs: 5000 });
    expect(r).toMatchObject({ status: 200, error: null, truncated: true });
    expect(r.response).toHaveLength(RESPONSE_EXCERPT_BYTES - 1);
    expect(delivered(r)).toBe(true);
    expect(r.durationMs).toBeLessThan(2000);
  });

  it('fails a response whose body is too slow, and one cut off', async () => {
    const slow = await serve((_req, res) => {
      res.writeHead(200);
      res.write('partial');
    });
    const r = await send(req(slow), { timeoutMs: 300 });
    expect(r).toMatchObject({ status: 200, error: 'timed out after 300 ms', response: 'partial' });
    expect(delivered(r)).toBe(false);

    const cut = await serve((_req, res) => {
      res.writeHead(200, { 'content-length': '100' });
      res.write('short');
      setTimeout(() => res.destroy(), 20);
    });
    const c = await send(req(cut), { timeoutMs: 2000 });
    expect(c.status).toBe(200);
    expect(c.error).not.toBeNull();
    expect(delivered(c)).toBe(false);
  });

  it('does not follow redirects', async () => {
    let hits = 0;
    const target = await serve((_req, res) => {
      hits++;
      res.end();
    });
    const url = await serve((_req, res) => {
      res.writeHead(302, { location: target }).end();
    });
    const r = await send(req(url), { timeoutMs: 2000 });
    expect(r).toMatchObject({ status: 302, error: null });
    expect(delivered(r)).toBe(false);
    expect(hits).toBe(0);
  });

  it('reads Retry-After only on 429 and 503', async () => {
    const url = await serve((request, res) => {
      const status = Number(request.url?.slice(1) || 200);
      res.writeHead(status, { 'retry-after': '7' }).end();
    });
    expect((await send(req(`${url}429`), { timeoutMs: 2000 })).retryAfterMs).toBe(7000);
    expect((await send(req(`${url}503`), { timeoutMs: 2000 })).retryAfterMs).toBe(7000);
    expect((await send(req(`${url}500`), { timeoutMs: 2000 })).retryAfterMs).toBeNull();
  });

  it('gives up at once when aborted, and on a bad URL', async () => {
    const url = await serve(() => {
      // Never answers.
    });
    const controller = new AbortController();
    const pending = send(req(url), { timeoutMs: 5000, signal: controller.signal });
    setTimeout(() => {
      controller.abort();
    }, 50);
    expect(await pending).toMatchObject({ status: null, error: 'the server is shutting down' });
    const aborted = new AbortController();
    aborted.abort();
    expect((await send(req(url), { timeoutMs: 5000, signal: aborted.signal })).error).toBe(
      'the server is shutting down',
    );
    expect((await send(req('not a url'), { timeoutMs: 100 })).error).toBe('invalid URL');
  });
});

describe('webhook helpers', () => {
  it('match actions by exact name, prefix or wildcard', () => {
    expect(matchesEvent(['*'], 'anything.at.all')).toBe(true);
    expect(matchesEvent(['flag.*'], 'flag.kill_switch')).toBe(true);
    expect(matchesEvent(['flag.*'], 'flags.kill_switch')).toBe(false);
    expect(matchesEvent(['flag.*'], 'flag')).toBe(false);
    expect(matchesEvent(['flag.kill_switch'], 'flag.kill_switch')).toBe(true);
    expect(matchesEvent(['flag.kill_switch'], 'flag.kill_switch.x')).toBe(false);
    expect(matchesEvent(['segment.*', 'flag.create'], 'flag.create')).toBe(true);
  });

  it('accept only plain http and https URLs', () => {
    expect(isWebhookUrl('https://hooks.example.com/a?b=c')).toBe(true);
    expect(isWebhookUrl('http://10.0.0.1:8080/')).toBe(true);
    expect(isWebhookUrl('https://example.com/#')).toBe(false);
    expect(isWebhookUrl('javascript:alert(1)')).toBe(false);
    expect(isWebhookUrl('https://:pw@example.com/')).toBe(false);
    expect(isWebhookUrl('nope')).toBe(false);
    expect(maskUrl('https://example.com/a/b?token=x')).toBe('https://example.com/a/b?…');
    expect(maskUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(maskUrl('nope')).toBe('nope');
  });

  it('sign t.body with each secret', () => {
    const at = new Date('2030-01-01T00:00:00.900Z');
    const header = signatureHeader(['a', 'b'], at, '{"x":1}');
    const t0 = Math.floor(at.getTime() / 1000);
    expect(header).toBe(
      [
        `t=${t0}`,
        `v1=${createHmac('sha256', 'a').update(`${t0}.{"x":1}`).digest('hex')}`,
        `v1=${createHmac('sha256', 'b').update(`${t0}.{"x":1}`).digest('hex')}`,
      ].join(','),
    );
  });

  it('back off on a jittered schedule, longer when asked, never past an hour', () => {
    expect(backoffMs(1, null, () => 0)).toBe(9000);
    expect(backoffMs(1, null, () => 1)).toBe(11_000);
    expect(backoffMs(2, null, () => 0.5)).toBe(30_000);
    expect(backoffMs(7, null, () => 0.5)).toBe(3_600_000);
    expect(backoffMs(40, null, () => 1)).toBe(3_600_000);
    expect(backoffMs(1, 120_000, () => 0.5)).toBe(120_000);
    expect(backoffMs(1, 86_400_000, () => 0.5)).toBe(3_600_000);
    for (let i = 0; i < 100; i++) {
      const ms = backoffMs(3, null);
      expect(ms).toBeGreaterThanOrEqual(54_000);
      expect(ms).toBeLessThanOrEqual(66_000);
    }
  });

  it('parse Retry-After as seconds or a date', () => {
    const now = new Date('2030-01-01T00:00:00Z');
    expect(parseRetryAfter(undefined, now)).toBeNull();
    expect(parseRetryAfter(' 30 ', now)).toBe(30_000);
    expect(parseRetryAfter('Tue, 01 Jan 2030 00:01:00 GMT', now)).toBe(60_000);
    expect(parseRetryAfter('Mon, 31 Dec 2029 00:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('soon', now)).toBeNull();
  });

  it('drop before and after from payloads over 256 KiB', () => {
    const event = {
      id: 9,
      tx: '1',
      at: new Date('2030-01-01T00:00:00Z'),
      projectId: 'p',
      environmentId: null,
      action: 'segment.update',
      targetType: 'segment',
      targetKey: 'big',
      actor: { id: null, name: 'a' },
      reason: 'why',
      link: null,
      before: null,
      after: { included: Array.from({ length: 30_000 }, (_, i) => `user-${i}`) },
    };
    const big = JSON.parse(buildPayload(event, 'default', null)) as WebhookPayload;
    expect(big).toMatchObject({
      id: 'evt_9',
      reason: 'why',
      before: null,
      after: null,
      truncated: true,
    });
    const small = JSON.parse(
      buildPayload({ ...event, after: { x: 1 } }, 'default', 'production'),
    ) as WebhookPayload;
    expect(small).toMatchObject({ after: { x: 1 }, environment: 'production' });
    expect(small).not.toHaveProperty('truncated');
    expect(Buffer.byteLength(buildPayload(event, 'default', null))).toBeLessThan(MAX_PAYLOAD_BYTES);
  });
});

describe('refusing private receivers', () => {
  it('rejects literal private, loopback and link-local URLs when a webhook is saved', async () => {
    for (const url of [
      'http://10.0.0.1/hook',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]:8080/',
      'http://[fd00::1]/',
      'http://2130706434/', // 127.0.0.2: only 127.0.0.1 is allowed here
      'http://localhost:9000/',
      'http://127.0.0.2/',
    ]) {
      const res = await admin.request('POST', `${P}/webhooks`, { name: 'internal', url });
      expect(res.statusCode, url).toBe(400);
      expect(res.json<{ error: { details: { path: string; message: string }[] } }>()).toMatchObject(
        {
          error: {
            details: [
              {
                path: 'url',
                message: expect.stringMatching(
                  /^refusing to connect to .*; list it in FLAGSHIP_WEBHOOK_ALLOWED_TARGETS to allow it$/,
                ) as unknown,
              },
            ],
          },
        },
      );
    }
    // The allow-listed loopback receiver is fine, and so is a public name (checked at delivery).
    const ok = await hook({ name: 'allowed', url: receiver.url('/allowed'), enabled: false });
    const patched = await admin.request('PATCH', `${P}/webhooks/${ok.id}`, {
      url: 'http://192.168.1.1/x',
    });
    expect(patched.statusCode).toBe(400);
    expect(
      (await admin.request('PATCH', `${P}/webhooks/${ok.id}`, { url: 'https://example.com/x' }))
        .statusCode,
    ).toBe(200);
    await admin.request('DELETE', `${P}/webhooks/${ok.id}`);
  });

  it('refuses at delivery time, and keeps retrying, a URL that is no longer allowed', async () => {
    const h = await hook({
      name: 'moved',
      url: receiver.url('/moved'),
      events: ['flag.kill_switch'],
    });
    // As if it was saved under an older allow-list: same receiver, another loopback address.
    const port = new URL(receiver.url()).port;
    await t.db
      .updateTable('webhooks')
      .set({ url: `http://127.0.0.2:${port}/moved` })
      .where('id', '=', h.id)
      .execute();
    await flag('moved');
    await kill('moved', 'production');
    await settle(async () => (await deliveries(h.id))[0]?.attempts === 1);
    const [d] = await deliveries(h.id);
    expect(d).toMatchObject({
      status: 'pending',
      last_status: null,
      last_error:
        'refusing to connect to 127.0.0.2: a loopback address; ' +
        'list it in FLAGSHIP_WEBHOOK_ALLOWED_TARGETS to allow it',
    });
    expect(receiver.at('/moved')).toHaveLength(0);
    const [a] = await attempts(d?.id ?? '');
    expect(a).toMatchObject({ attempt: 1, status: null, error: d?.last_error });
    await admin.request('DELETE', `${P}/webhooks/${h.id}`);
  });
});

describe('sending with an egress policy', () => {
  const server = http.createServer((_req, res) => {
    hits++;
    res.writeHead(204).end();
  });
  let hits = 0;
  let port = 0;
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  // A resolver that knows one public-looking name, pointed at loopback: DNS rebinding.
  const rebinding = (allow: string[] = []) =>
    new EgressPolicy(allow, {
      resolve: (host) =>
        host === 'hooks.rebind.test'
          ? Promise.resolve([{ address: '127.0.0.1', family: 4 }])
          : Promise.reject(Object.assign(new Error(`ENOTFOUND ${host}`), { code: 'ENOTFOUND' })),
    });
  const post = (url: string, egress: EgressPolicy) =>
    send({ url, headers: {}, body: '{}' }, { timeoutMs: 2000, egress });

  it('never opens a connection to a refused literal address', async () => {
    const before = hits;
    const r = await post(`http://127.0.0.1:${port}/`, new EgressPolicy());
    expect(r).toMatchObject({ status: null, durationMs: 0 });
    expect(r.error).toMatch(/^refusing to connect to 127\.0\.0\.1: a loopback address/);
    expect(delivered(r)).toBe(false);
    expect(hits).toBe(before);
  });

  it('checks the address a name resolves to when the socket connects', async () => {
    const before = hits;
    const refused = await post(`http://hooks.rebind.test:${port}/`, rebinding());
    expect(refused.status).toBeNull();
    expect(refused.error).toBe(
      'refusing to connect to 127.0.0.1 (resolved from hooks.rebind.test): a loopback address; ' +
        'list it in FLAGSHIP_WEBHOOK_ALLOWED_TARGETS to allow it',
    );
    expect(hits).toBe(before);

    // The same request goes through once the name or the address is allowed,
    // which also shows the policy's resolver is the one the socket used.
    for (const allow of [['hooks.rebind.test'], ['127.0.0.0/8']]) {
      const r = await post(`http://hooks.rebind.test:${port}/`, rebinding(allow));
      expect(r, allow[0]).toMatchObject({ status: 204, error: null });
    }
    expect(hits).toBe(before + 2);
    const missing = await post(`http://nowhere.rebind.test:${port}/`, rebinding());
    expect(missing.error).toMatch(/ENOTFOUND/);
  });

  it('applies through keep-alive agents, as the worker sends', async () => {
    const agents = {
      http: new http.Agent({ keepAlive: true }),
      https: new https.Agent({ keepAlive: true }),
    };
    const url = `http://hooks.rebind.test:${port}/`;
    try {
      const refused = await send(
        { url, headers: {}, body: '{}' },
        { timeoutMs: 2000, egress: rebinding(), agents },
      );
      expect(refused.error).toMatch(/^refusing to connect to 127\.0\.0\.1 \(resolved from/);
      const ok = await send(
        { url, headers: {}, body: '{}' },
        { timeoutMs: 2000, egress: rebinding(['hooks.rebind.test']), agents },
      );
      expect(ok).toMatchObject({ status: 204, error: null });
    } finally {
      agents.http.destroy();
      agents.https.destroy();
    }
  });
});
