import type { AddressInfo } from 'node:net';
import { FlagshipClient } from '@flagship/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApp, type TestApp } from '../test/app.js';
import { PASSWORD, signIn, type Client } from '../test/session.js';

let t: TestApp;
let admin: Client;
let sdk: FlagshipClient;

const P = '/api/projects/default';
const T = `${P}/flags/new-checkout/environments/production`;
const users = Array.from({ length: 2000 }, (_, i) => ({ key: `user-${i}` }));

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function rollout(percent: number): Promise<void> {
  const flag = (await admin.request('GET', `${P}/flags/new-checkout`)).json();
  const on = percent * 1000;
  const res = await admin.request('PUT', T, {
    version: flag.version,
    enabled: true,
    offVariant: 'off',
    prerequisites: [],
    rules: [],
    fallthrough: {
      rollout: {
        variants: [
          { variant: 'on', weight: on },
          { variant: 'off', weight: 100_000 - on },
        ],
      },
    },
  });
  expect(res.statusCode, res.body).toBe(200);
}

const enabledUsers = () =>
  new Set(users.filter((u) => sdk.boolVariation('new-checkout', u, false)).map((u) => u.key));

beforeAll(async () => {
  t = await testApp({
    bootstrapAdmin: { email: 'root@example.com', password: PASSWORD },
    eventsFlushMs: 50,
  });
  admin = await signIn(t.app.server, 'root@example.com');
  await t.app.server.listen({ port: 0, host: '127.0.0.1' });
  const port = (t.app.server.server.address() as AddressInfo).port;
  const key = (
    await admin.request('POST', `${P}/environments/production/api-keys`, {
      kind: 'server',
      name: 'e2e',
    })
  ).json().secret;
  sdk = new FlagshipClient({
    sdkKey: key,
    baseUrl: `http://127.0.0.1:${port}`,
    exposureFlushMs: 100,
  });
  expect(await sdk.ready()).toBe(true);
});
afterAll(async () => {
  await sdk.close();
  await t.close();
});

describe('Node SDK against the real server', () => {
  it('sees a new flag, follows a rollout from 10% to 50% without moving anyone out, and obeys the kill switch', async () => {
    await admin.request('POST', `${P}/flags`, {
      key: 'new-checkout',
      name: 'New checkout',
      type: 'boolean',
    });
    await until(() => sdk.flagKeys().includes('new-checkout'));
    expect(enabledUsers().size).toBe(0);

    await rollout(10);
    await until(() => enabledUsers().size > 0);
    const ten = enabledUsers();
    expect(ten.size / users.length).toBeGreaterThan(0.08);
    expect(ten.size / users.length).toBeLessThan(0.12);

    await rollout(50);
    await until(() => enabledUsers().size > ten.size);
    const fifty = enabledUsers();
    expect(fifty.size / users.length).toBeGreaterThan(0.47);
    expect(fifty.size / users.length).toBeLessThan(0.53);
    for (const u of ten) expect(fifty.has(u)).toBe(true);

    await admin.request('POST', `${T}/kill-switch`, { enabled: false });
    await until(() => enabledUsers().size === 0);
  });

  it('reports exposures that show up in the per-variant counts', async () => {
    await admin.request('POST', `${T}/kill-switch`, { enabled: true });
    await until(() => enabledUsers().size > 0);
    await sdk.flush();
    await t.app.exposures.flush();
    const summary = (
      await admin.request('GET', `${P}/flags/new-checkout/exposures?environment=production`)
    ).json();
    const total = summary.totals.reduce((n: number, v: { count: number }) => n + v.count, 0);
    expect(total).toBeGreaterThan(users.length);
    expect(summary.totals.map((v: { variant: string }) => v.variant).sort()).toEqual(['off', 'on']);
  });
});
