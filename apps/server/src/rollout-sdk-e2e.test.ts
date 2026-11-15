import type { AddressInfo } from 'node:net';
import { ROLLOUT_TOTAL } from '@flagship/core';
import { FlagshipClient } from '@flagship/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApp, type TestApp } from '../test/app.js';
import { PASSWORD, signIn, type Client } from '../test/session.js';

/**
 * A progressive rollout driven by the scheduler, watched through the Node SDK
 * over the real stream: at every step nobody who had the new variant loses
 * it, companies stay together, and the first exposures the SDK reports are
 * the ones the experiment counts, whichever step a context first showed up at.
 */

let t: TestApp;
let admin: Client;
let sdk: FlagshipClient;
// Starts at the real time: the SDK stamps exposures with it, and the server
// accepts them up to 7 days old. The test then moves the clock an hour a step.
let clock = new Date();

const P = '/api/projects/default';
const FLAG = 'stepped-checkout';
const steps = [
  { weight: 5_000, holdMinutes: 60 },
  { weight: 25_000, holdMinutes: 60 },
  { weight: 60_000, holdMinutes: 60 },
  { weight: ROLLOUT_TOTAL },
];
const cohort = (name: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({ key: `${name}-${i}`, org: `${name}-org-${i % 500}` }));
// A is seen from the first step, B first at the third, C only once everyone has the variant.
const A = cohort('a', 1500);
const B = cohort('b', 1500);
const C = cohort('c', 500);

async function until(check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function serverVersion(): Promise<number> {
  return (await admin.request('GET', `${P}/environments/production/ruleset`)).json().version;
}

function serve(users: { key: string; org: string }[]) {
  return users.map((u) => ({ key: u.key, org: u.org, ...sdk.boolDetail(FLAG, u, false) }));
}

beforeAll(async () => {
  t = await testApp(
    {
      bootstrapAdmin: { email: 'root@example.com', password: PASSWORD },
      schedulerIntervalMs: 3_600_000,
      eventsFlushMs: 3_600_000,
    },
    { now: () => clock },
  );
  admin = await signIn(t.app.server, 'root@example.com');
  await t.app.server.listen({ port: 0, host: '127.0.0.1' });
  const port = (t.app.server.server.address() as AddressInfo).port;
  const key = (
    await admin.request('POST', `${P}/environments/production/api-keys`, {
      kind: 'server',
      name: 'steps',
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

describe('a progressive rollout seen through the Node SDK', () => {
  it('keeps stickiness and companies together at every step, and reports first exposures once', async () => {
    const created = await admin.request('POST', `${P}/flags`, {
      key: FLAG,
      name: FLAG,
      type: 'boolean',
    });
    expect(created.statusCode, created.body).toBe(201);
    const on = await admin.request(
      'POST',
      `${P}/flags/${FLAG}/environments/production/kill-switch`,
      { enabled: true },
    );
    expect(on.statusCode, on.body).toBe(200);
    const started = await admin.request(
      'POST',
      `${P}/flags/${FLAG}/environments/production/rollout-plans`,
      { target: 'fallthrough', variant: 'on', baseline: 'off', bucketBy: 'org', steps },
    );
    expect(started.statusCode, started.body).toBe(201);

    const firstServed = new Map<string, boolean>();
    let had = new Set<string>();
    for (let step = 0; step < steps.length; step++) {
      const version = await serverVersion();
      await until(() => sdk.version === version);

      const seen = [...A, ...(step >= 2 ? B : []), ...(step === steps.length - 1 ? C : [])];
      const details = serve(seen);
      const final = step === steps.length - 1;
      for (const d of details) {
        expect(d.reason).toBe(final ? 'DEFAULT' : 'SPLIT');
        if (!firstServed.has(d.key)) firstServed.set(d.key, d.value);
      }
      const now = new Set(details.filter((d) => d.value).map((d) => d.key));
      for (const key of had) expect(now.has(key), `${key} lost the variant`).toBe(true);
      const byOrg = new Map<string, boolean>();
      for (const d of details) {
        const peer = byOrg.get(d.org);
        if (peer === undefined) byOrg.set(d.org, d.value);
        else expect(d.value, `${d.org} split up`).toBe(peer);
      }
      const shareA = details.slice(0, A.length).filter((d) => d.value).length / A.length;
      expect(Math.abs(shareA - (steps[step]?.weight ?? 0) / ROLLOUT_TOTAL)).toBeLessThan(0.08);
      had = now;

      clock = new Date(clock.getTime() + 60 * 60_000);
      expect(await t.app.scheduler.runOnce()).toBe(final ? 0 : 1);
    }
    expect(had.size).toBe(A.length + B.length + C.length);

    // The SDK reports a first exposure only for contexts a split bucketed, so
    // C, first seen once everyone has the variant, is not in the experiment.
    await sdk.flush();
    await t.app.experiments.flush();
    const rows = await t.db
      .selectFrom('experiment_exposures')
      .select(['context_key', 'variant'])
      .where('flag_key', '=', FLAG)
      .execute();
    expect(rows).toHaveLength(A.length + B.length);
    const stored = new Map(rows.map((r) => [r.context_key, r.variant]));
    for (const u of [...A, ...B]) {
      expect(stored.get(u.key)).toBe(firstServed.get(u.key) ? 'on' : 'off');
    }
    for (const u of C) expect(stored.has(u.key)).toBe(false);
    // B joined at the 60% step, so more of it started on the variant than A did at 5%.
    const startedOn = (users: { key: string }[]) =>
      users.filter((u) => stored.get(u.key) === 'on').length / users.length;
    expect(startedOn(A)).toBeLessThan(0.1);
    expect(startedOn(B)).toBeGreaterThan(0.5);
  });
});
