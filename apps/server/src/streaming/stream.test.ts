import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../app.js';
import { createDatabase } from '../db/database.js';
import { testApp, type TestApp } from '../../test/app.js';
import { PASSWORD, signIn, type Client } from '../../test/session.js';
import { openStream, type SseClient } from '../../test/sse.js';
import { createLogger } from '../log.js';
import { formatEvent } from './hub.js';

let t: TestApp;
let admin: Client;
let base: string;
let serverKey: string;
let clientKey: string;
let serverKeyId: string;

const P = '/api/projects/default';

async function listen(app: App): Promise<string> {
  await app.server.listen({ port: 0, host: '127.0.0.1' });
  return `http://127.0.0.1:${(app.server.server.address() as AddressInfo).port}`;
}

async function createFlag(key: string): Promise<number> {
  const res = await admin.request('POST', `${P}/flags`, { key, name: key, type: 'boolean' });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().version;
}

async function kill(key: string, enabled: boolean): Promise<void> {
  const res = await admin.request('POST', `${P}/flags/${key}/environments/production/kill-switch`, {
    enabled,
  });
  expect(res.statusCode, res.body).toBe(200);
}

const stream = (key = serverKey, headers: Record<string, string> = {}) =>
  openStream(`${base}/sdk/v1/stream`, { authorization: `Bearer ${key}`, ...headers });

beforeAll(async () => {
  t = await testApp({
    bootstrapAdmin: { email: 'root@example.com', password: PASSWORD },
    heartbeatSeconds: 1,
    maxStreamsPerKey: 3,
    changeRetention: 10,
  });
  admin = await signIn(t.app.server, 'root@example.com');
  base = await listen(t.app);
  const keys = `${P}/environments/production/api-keys`;
  const s = (await admin.request('POST', keys, { kind: 'server', name: 'svc' })).json();
  serverKey = s.secret;
  serverKeyId = s.id;
  clientKey = (await admin.request('POST', keys, { kind: 'client', name: 'web' })).json().secret;
});
afterAll(() => t.close());

describe('ruleset snapshot', () => {
  it('serves the ruleset with a strong ETag and answers 304 when unchanged', async () => {
    await createFlag('etag-flag');
    const first = await fetch(`${base}/sdk/v1/ruleset`, {
      headers: { authorization: `Bearer ${serverKey}` },
    });
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag') ?? '';
    expect(etag).toMatch(/^"[0-9a-f]{8}-\d+"$/);
    const body: any = await first.json();
    expect(body.flags['etag-flag']).toMatchObject({ key: 'etag-flag', enabled: false });
    const again = await fetch(`${base}/sdk/v1/ruleset`, {
      headers: { authorization: `Bearer ${serverKey}`, 'if-none-match': etag },
    });
    expect(again.status).toBe(304);
    await kill('etag-flag', true);
    const changed = await fetch(`${base}/sdk/v1/ruleset`, {
      headers: { authorization: `Bearer ${serverKey}`, 'if-none-match': etag },
    });
    expect(changed.status).toBe(200);
    expect(((await changed.json()) as any).flags['etag-flag'].enabled).toBe(true);
  });

  it('refuses client keys, which never see rules', async () => {
    const res = await fetch(`${base}/sdk/v1/ruleset`, {
      headers: { authorization: `Bearer ${clientKey}` },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const s = await stream(clientKey);
    expect(s.status).toBe(403);
  });

  it('answers CORS preflight for browser SDKs', async () => {
    const res = await fetch(`${base}/sdk/v1/evaluate`, {
      method: 'OPTIONS',
      headers: { origin: 'https://shop.example', 'access-control-request-method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-headers')).toContain('authorization');
  });
});

describe('streaming', () => {
  it('sends a put, then a patch for every change', async () => {
    const s = await stream();
    expect(s.status).toBe(200);
    const put = await s.next((e) => e.event === 'put');
    const ruleset = JSON.parse(put.data);
    expect(put.id).toBe(String(ruleset.version));
    await createFlag('streamed');
    const patch = await s.next((e) => e.event === 'patch');
    expect(Number(patch.id)).toBe(ruleset.version + 1);
    expect(JSON.parse(patch.data)).toMatchObject({
      kind: 'flag',
      key: 'streamed',
      value: { enabled: false },
    });
    await kill('streamed', true);
    const second = await s.next((e) => e.event === 'patch');
    expect(JSON.parse(second.data).value.enabled).toBe(true);
    s.close();
  });

  it('resumes from Last-Event-ID with exactly the missed patches', async () => {
    await createFlag('resume');
    const s = await stream();
    const put = await s.next((e) => e.event === 'put');
    s.close();
    await kill('resume', true);
    await kill('resume', false);
    await kill('resume', true);
    const back = await stream(serverKey, { 'last-event-id': put.id ?? '' });
    const got = [await back.next(), await back.next(), await back.next()];
    expect(got.map((e) => e.event)).toEqual(['patch', 'patch', 'patch']);
    expect(got.map((e) => Number(e.id))).toEqual([1, 2, 3].map((i) => Number(put.id) + i));
    expect(got.map((e) => JSON.parse(e.data).value.enabled)).toEqual([true, false, true]);
    await new Promise((r) => setTimeout(r, 300));
    expect(back.events.filter((e) => e.event === 'put')).toHaveLength(0);
    back.close();
  });

  it('sends a fresh put when the missed history has been pruned or the id is from the future', async () => {
    await createFlag('pruned');
    const s = await stream();
    const put = await s.next((e) => e.event === 'put');
    s.close();
    for (let i = 0; i < 12; i++) await kill('pruned', i % 2 === 0);
    const back = await stream(serverKey, { 'last-event-id': put.id ?? '' });
    const first = await back.next();
    expect(first.event).toBe('put');
    expect(JSON.parse(first.data).flags.pruned.enabled).toBe(false);
    back.close();
    const future = await stream(serverKey, { 'last-event-id': '999999999' });
    expect((await future.next()).event).toBe('put');
    future.close();
  });

  it('carries a change made through one instance to a stream on another', async () => {
    const { db } = createDatabase({ url: t.url, maxConnections: 5 });
    const other = await buildApp({ config: t.config, db, logger: createLogger('silent') });
    try {
      const otherBase = await listen(other);
      const s = await openStream(`${otherBase}/sdk/v1/stream`, {
        authorization: `Bearer ${serverKey}`,
      });
      await s.next((e) => e.event === 'put');
      await createFlag('cross-instance');
      const patch = await s.next((e) => e.event === 'patch');
      expect(JSON.parse(patch.data).key).toBe('cross-instance');
      s.close();
    } finally {
      await other.close();
      await db.destroy();
    }
  });

  it('sends heartbeats', async () => {
    const s = await stream();
    await s.next((e) => e.event === 'put');
    await new Promise((r) => setTimeout(r, 1300));
    expect(s.comments).toBeGreaterThan(0);
    s.close();
  });

  it('limits streams per server key', async () => {
    const open: SseClient[] = [];
    for (let i = 0; i < 3; i++) {
      const s = await stream();
      await s.next((e) => e.event === 'put');
      open.push(s);
    }
    const fourth = await stream();
    expect(fourth.status).toBe(429);
    for (const s of open) s.close();
    await new Promise((r) => setTimeout(r, 100));
    const again = await stream();
    expect(again.status).toBe(200);
    again.close();
  });

  it('closes streams as soon as their key is revoked', async () => {
    const keys = `${P}/environments/production/api-keys`;
    const k = (await admin.request('POST', keys, { kind: 'server', name: 'temp' })).json();
    const s = await stream(k.secret);
    await s.next((e) => e.event === 'put');
    await admin.request('DELETE', `${keys}/${k.id}`);
    await s.ended;
    expect(t.app.metrics.streamDrops.get({ reason: 'revoked' })).toBeGreaterThan(0);
    expect(serverKeyId).not.toBe(k.id);
  });

  it('tells client streams only the new version, with the key in the query string', async () => {
    const s = await openStream(`${base}/sdk/v1/client-stream?key=${clientKey}`);
    expect(s.status).toBe(200);
    const first = await s.next();
    expect(first.event).toBe('version');
    await createFlag('client-visible');
    const next = await s.next();
    expect(next.event).toBe('version');
    expect(JSON.parse(next.data).version).toBe(Number(first.id) + 1);
    expect(next.data).not.toContain('client-visible');
    s.close();
    const resumed = await openStream(`${base}/sdk/v1/client-stream?key=${clientKey}`, {
      'last-event-id': next.id ?? '',
    });
    expect((await resumed.next()).data).toBe(JSON.stringify({ version: Number(next.id) }));
    resumed.close();
    const noKey = await openStream(`${base}/sdk/v1/client-stream`);
    expect(noKey.status).toBe(401);
  });

  it('ends every stream on shutdown and refuses new ones', async () => {
    const other = await testApp({ bootstrapAdmin: { email: 'a@example.com', password: PASSWORD } });
    const c = await signIn(other.app.server, 'a@example.com');
    const key = (
      await c.request('POST', `${P}/environments/production/api-keys`, {
        kind: 'server',
        name: 'x',
      })
    ).json().secret;
    const url = await listen(other.app);
    const s = await openStream(`${url}/sdk/v1/stream`, { authorization: `Bearer ${key}` });
    await s.next((e) => e.event === 'put');
    expect(other.app.hub.canAccept({ kind: 'server', keyId: 'x' })).toBeUndefined();
    const closing = other.close();
    await s.ended;
    await closing;
    expect(other.app.hub.canAccept({ kind: 'server', keyId: 'x' })).toBe('server is shutting down');
  });
});

describe('formatEvent', () => {
  it('writes one SSE event with id, name and JSON data', () => {
    expect(formatEvent('patch', 7, { a: 1 })).toBe('id: 7\nevent: patch\ndata: {"a":1}\n\n');
  });
});
