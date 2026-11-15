import { evaluate, ROLLOUT_TOTAL, type Ruleset } from '@flagship/core';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../app.js';
import { createDatabase, type Db } from '../db/database.js';
import { createLogger } from '../log.js';
import { createMetrics } from '../metrics.js';
import { testApp, type TestApp } from '../../test/app.js';
import { PASSWORD, signIn, userWithRole, type Client } from '../../test/session.js';
import { experimentRollup, rollupBacklog } from './experimentRollup.js';

/**
 * The whole experiment pipeline, from `POST /sdk/v1/events` on two instances
 * through the hourly rollup (two workers) to the results route:
 *
 * - a model-based property: random exposures reported by several SDKs,
 *   conversions on and around the attribution window's edges, retried
 *   copies, all sent in random order and batches at random times, must give
 *   exactly the per-variant numbers a direct computation gives;
 * - the sample ratio check on biased fixtures built from real evaluations:
 *   fair splits pass, lost or misreported exposures and a rollout that steps
 *   during the experiment are caught and the results hidden.
 */

let t: TestApp;
let editor: Client;
let viewer: Client;
let other: { app: App; db: Db };
let sdkKey: string;
let clock = new Date('2031-03-02T08:00:00Z');
let flags = 0;

const P = '/api/projects/default';
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WINDOW = 7 * DAY;
const half = ROLLOUT_TOTAL / 2;

interface Exposure {
  flag: string;
  variant: string;
  key: string;
  at: number;
}
interface Conversion {
  id: string;
  event: string;
  key: string;
  value?: number;
  at: number;
}
type Item = { exposure: Exposure } | { conversion: Conversion };

/** mulberry32: a small seeded generator so a failing case replays exactly. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function shuffle<T>(xs: T[], rand: () => number): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [xs[i], xs[j]] = [xs[j]!, xs[i]!];
  }
  return xs;
}

async function post(app: App, items: Item[]) {
  const exposures = items.flatMap((i) => ('exposure' in i ? [i.exposure] : []));
  const conversions = items.flatMap((i) => ('conversion' in i ? [i.conversion] : []));
  const res = await app.server.inject({
    method: 'POST',
    url: '/sdk/v1/events',
    headers: { authorization: `Bearer ${sdkKey}` },
    payload: {
      ...(exposures.length > 0 ? { exposures } : {}),
      ...(conversions.length > 0 ? { conversions } : {}),
    },
  });
  expect(res.statusCode, res.body).toBe(202);
  expect(res.json().dropped).toBe(0);
}

const flushQueues = () => Promise.all([t.app.experiments.flush(), other.app.experiments.flush()]);

const rollupJobs = () =>
  [t.db, other.db].map((db) =>
    experimentRollup({ db, metrics: createMetrics(), logger: createLogger('silent') }),
  );

/** Both workers race until nothing is left to roll up. */
async function rollUpAll() {
  const jobs = rollupJobs();
  for (;;) {
    await Promise.all(jobs.map((job) => job()));
    const left = await rollupBacklog(t.db);
    if (left.hours === 0 && left.contexts === 0) return;
  }
}

async function targeting(key: string, patch: Record<string, unknown>) {
  const current = (await viewer.request('GET', `${P}/flags/${key}`)).json().environments.production;
  const res = await editor.request('PUT', `${P}/flags/${key}/environments/production`, {
    version: current.version,
    enabled: current.enabled,
    offVariant: current.offVariant,
    prerequisites: current.prerequisites,
    rules: current.rules,
    fallthrough: current.fallthrough,
    ...patch,
  });
  expect(res.statusCode, res.body).toBe(200);
}

const split = (on: number) => ({
  rollout: {
    variants: [
      { variant: 'on', weight: on },
      { variant: 'off', weight: ROLLOUT_TOTAL - on },
    ],
  },
});

async function newFlag(fallthrough: unknown): Promise<string> {
  const key = `pipe-${++flags}`;
  const res = await editor.request('POST', `${P}/flags`, { key, name: key, type: 'boolean' });
  expect(res.statusCode, res.body).toBe(201);
  await targeting(key, { enabled: true, fallthrough });
  return key;
}

async function startExperiment(flag: string): Promise<string> {
  const res = await editor.request('POST', `${P}/experiments`, {
    key: `${flag}-x`,
    name: flag,
    flag,
    environment: 'production',
    control: 'off',
    metrics: [
      { event: 'purchase' },
      { event: 'purchase', kind: 'count' },
      { event: 'purchase', kind: 'value' },
    ],
  });
  expect(res.statusCode, res.body).toBe(201);
  return `${flag}-x`;
}

async function results(key: string, query = '') {
  const res = await viewer.request('GET', `${P}/experiments/${key}/results${query}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

beforeAll(async () => {
  t = await testApp(
    {
      bootstrapAdmin: { email: 'root@example.com', password: PASSWORD },
      schedulerIntervalMs: 3_600_000,
      eventsFlushMs: 3_600_000,
      eventsQueueLimit: 1_000_000,
      sessionIdleMinutes: 10_000_000,
      sessionMaxHours: 10_000_000,
    },
    { now: () => clock },
  );
  const admin = await signIn(t.app.server, 'root@example.com');
  editor = await userWithRole(t.app.server, t.db, 'eddie@example.com', 'editor');
  viewer = await userWithRole(t.app.server, t.db, 'vera@example.com', 'viewer');
  sdkKey = (
    await admin.request('POST', `${P}/environments/production/api-keys`, {
      kind: 'server',
      name: 'pipeline',
    })
  ).json().secret;
  const { db } = createDatabase({ url: t.url, maxConnections: 5 });
  other = {
    app: await buildApp({ config: t.config, db, logger: createLogger('silent'), now: () => clock }),
    db,
  };
});
afterAll(async () => {
  await other.app.close();
  await other.db.destroy();
  await t.close();
});

// Where a conversion falls against its context's first exposure; `edge` is
// exactly 7 days after it, the first instant outside the half-open window.
const placements = ['before', 'at', 'inside', 'lastMs', 'edge', 'after'] as const;

const contextArb = fc.record({
  reports: fc.array(
    fc.record({
      variant: fc.constantFrom('off', 'on'),
      minutes: fc.integer({ min: 0, max: 48 * 60 }),
    }),
    { minLength: 0, maxLength: 3 },
  ),
  conversions: fc.array(
    fc.record({
      event: fc.constantFrom('purchase', 'purchase', 'purchase', 'signup'),
      placement: fc.constantFrom(...placements),
      fraction: fc.double({ min: 0, max: 1, noNaN: true, maxExcluded: true }),
      value: fc.option(fc.integer({ min: 0, max: 500 }), { nil: undefined }),
      copies: fc.integer({ min: 1, max: 3 }),
    }),
    { maxLength: 4 },
  ),
});

describe('first-exposure attribution through ingest, rollup and results (property)', () => {
  it('matches a direct computation whatever the order, batching, retries and instances', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(contextArb, { minLength: 4, maxLength: 40 }),
        fc.integer(),
        async (spec, seed) => {
          const rand = prng(seed);
          clock = new Date(clock.getTime() + 30 * DAY);
          const flag = await newFlag(split(half));
          const experiment = await startExperiment(flag);
          const t0 = clock.getTime() + MIN;

          const items: { item: Item; at: number }[] = [];
          const expected = new Map(
            ['off', 'on'].map((v) => [
              v,
              { variant: v, exposed: 0, converted: 0, conversions: 0, value: 0 },
            ]),
          );
          let ids = 0;
          spec.forEach((c, i) => {
            const key = `ctx-${i}`;
            const reports = c.reports.map((r) => ({
              variant: r.variant,
              at: t0 + r.minutes * MIN,
            }));
            for (const r of reports) {
              items.push({ item: { exposure: { flag, key, ...r } }, at: r.at });
            }
            const first = [...reports].sort(
              (a, b) => a.at - b.at || (a.variant < b.variant ? -1 : 1),
            )[0];
            // Contexts never exposed still convert; their conversions must not count.
            const anchor = first?.at ?? t0 + 24 * HOUR;
            let converted = false;
            for (const conv of c.conversions) {
              const offset = {
                before: -Math.floor(1 + conv.fraction * 10 * MIN),
                at: 0,
                inside: Math.floor(1 + conv.fraction * (WINDOW - 2)),
                lastMs: WINDOW - 1,
                edge: WINDOW,
                after: Math.floor(WINDOW + 1 + conv.fraction * DAY),
              }[conv.placement];
              const record: Conversion = {
                id: `conv-${flags}-${++ids}`,
                event: conv.event,
                key,
                at: anchor + offset,
                ...(conv.value === undefined ? {} : { value: conv.value }),
              };
              // A retried batch sends the same conversion again, possibly much later.
              for (let k = 0; k < conv.copies; k++) {
                items.push({ item: { conversion: record }, at: record.at });
              }
              const counts =
                first !== undefined && conv.event === 'purchase' && offset >= 0 && offset < WINDOW;
              if (counts) {
                const row = expected.get(first.variant)!;
                row.conversions++;
                row.value += conv.value ?? 0;
                converted = true;
              }
            }
            if (first !== undefined) {
              const row = expected.get(first.variant)!;
              row.exposed++;
              if (converted) row.converted++;
            }
          });

          // Twice a day for 11 days, each item sent at a random time the
          // server still accepts it: no more than 5 minutes early, no more
          // than 7 days late.
          const phases = Array.from({ length: 23 }, (_, k) => t0 - MIN + k * 12 * HOUR);
          const byPhase = phases.map(() => [] as Item[]);
          for (const { item, at } of items) {
            const valid = phases
              .map((p, k) => ({ p, k }))
              .filter(({ p }) => at <= p + 5 * MIN && at >= p - WINDOW + MIN);
            expect(valid.length).toBeGreaterThan(0);
            byPhase[valid[Math.floor(rand() * valid.length)]!.k]!.push(item);
          }
          for (let k = 0; k < phases.length; k++) {
            clock = new Date(phases[k]!);
            const pending = shuffle(byPhase[k]!, rand);
            while (pending.length > 0) {
              const batch = pending.splice(0, 1 + Math.floor(rand() * 30));
              await post(rand() < 0.5 ? t.app : other.app, batch);
              if (rand() < 0.2) await flushQueues();
            }
            await flushQueues();
            if (rand() < 0.4) await Promise.all(rollupJobs().map((job) => job()));
          }
          await rollUpAll();

          const r = await results(experiment, '?showMismatched=true');
          const want = [...expected.values()];
          expect(r.exposed).toBe(want[0]!.exposed + want[1]!.exposed);
          expect(r.variants.map((v: { exposed: number }) => v.exposed)).toEqual(
            want.map((w) => w.exposed),
          );
          for (const metric of r.metrics) {
            expect(
              metric.variants.map(
                (v: {
                  variant: string;
                  exposed: number;
                  converted: number;
                  conversions: number;
                  value: number;
                }) => ({
                  variant: v.variant,
                  exposed: v.exposed,
                  converted: v.converted,
                  conversions: v.conversions,
                  value: v.value,
                }),
              ),
            ).toEqual(want);
          }
        },
      ),
      { numRuns: 8, seed: 20261116 },
    );
  }, 300_000);
});

describe('sample ratio check on biased fixtures', () => {
  const users = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({ key: `${prefix}-${i}` }));

  async function served(flag: string, contexts: { key: string }[]) {
    const rs: Ruleset = (
      await viewer.request('GET', `${P}/environments/production/ruleset`)
    ).json();
    return contexts.map((c, i) => {
      const e = evaluate(rs, flag, c);
      expect(e.reason).toBe('SPLIT');
      return { i, key: c.key, variant: 'variant' in e ? e.variant : '' };
    });
  }

  /** Reports first exposures the way SDKs do, after `bias` has had its way with them. */
  async function report(
    flag: string,
    exposures: { i: number; key: string; variant: string }[],
    bias: (e: { i: number; variant: string }) => string | null = (e) => e.variant,
  ) {
    const items: Item[] = [];
    for (const e of exposures) {
      const variant = bias(e);
      if (variant !== null) {
        items.push({ exposure: { flag, key: e.key, variant, at: clock.getTime() - MIN } });
      }
    }
    for (let i = 0; i < items.length; i += 1000) {
      await post(i % 2000 === 0 ? t.app : other.app, items.slice(i, i + 1000));
    }
    await flushQueues();
    await rollUpAll();
  }

  async function fixture(on: number, bias?: (e: { i: number; variant: string }) => string | null) {
    clock = new Date(clock.getTime() + 30 * DAY);
    const flag = await newFlag(split(on));
    const experiment = await startExperiment(flag);
    clock = new Date(clock.getTime() + 10 * MIN);
    await report(flag, await served(flag, users(flag, 20_000)), bias);
    return results(experiment);
  }

  it('passes fair 50/50 and 10/90 splits of 20,000 contexts', async () => {
    for (const on of [half, ROLLOUT_TOTAL / 10]) {
      const r = await fixture(on);
      expect(r.exposed).toBe(20_000);
      expect(r.srm.mismatch).toBe(false);
      expect(r.srm.pValue).toBeGreaterThan(0.001);
      expect(r.warning).toBeNull();
      expect(r.metrics).toHaveLength(3);
      const share =
        r.variants.find((v: { variant: string }) => v.variant === 'on').exposed / 20_000;
      expect(Math.abs(share - on / ROLLOUT_TOTAL)).toBeLessThan(0.01);
    }
  });

  it('catches a client that loses one in twelve of the treatment’s exposures', async () => {
    // About 10,000 against 9,170: chi-square ≈ 36, far below p 0.001. (A 3% loss
    // at this size gives chi-square ≈ 4.6, which the check rightly can't tell from chance.)
    const r = await fixture(half, (e) => (e.variant === 'on' && e.i % 12 === 0 ? null : e.variant));
    expect(r.srm.mismatch).toBe(true);
    expect(r.srm.pValue).toBeLessThan(0.001);
    expect(r.warning).toMatchObject({ code: 'sample_ratio_mismatch' });
    expect(r.metrics).toBeNull();
  });

  it('catches a treatment that falls back to the control for 5% of its contexts', async () => {
    const r = await fixture(half, (e) =>
      e.variant === 'on' && e.i % 20 === 0 ? 'off' : e.variant,
    );
    expect(r.exposed).toBe(20_000);
    expect(r.srm.mismatch).toBe(true);
    expect(r.metrics).toBeNull();
  });

  it('catches a rollout that stepped during the experiment, and keeps each first exposure', async () => {
    clock = new Date(clock.getTime() + 30 * DAY);
    const flag = await newFlag({ variant: 'off' });
    const plan = await editor.request(
      'POST',
      `${P}/flags/${flag}/environments/production/rollout-plans`,
      {
        target: 'fallthrough',
        variant: 'on',
        baseline: 'off',
        steps: [
          { weight: ROLLOUT_TOTAL / 10, holdMinutes: 60 },
          { weight: half, holdMinutes: 60 },
          { weight: ROLLOUT_TOTAL },
        ],
      },
    );
    expect(plan.statusCode, plan.body).toBe(201);
    // Started on the 10% step, so that is the allocation it checks against.
    const experiment = await startExperiment(flag);
    clock = new Date(clock.getTime() + 10 * MIN);
    const early = await served(flag, users(`${flag}-a`, 10_000));
    await report(flag, early);
    const before = await results(experiment);
    expect(before.srm.mismatch).toBe(false);
    expect(before.allocationChanged).toBe(false);

    clock = new Date(clock.getTime() + 60 * MIN);
    expect(await t.app.scheduler.runOnce()).toBe(1);
    // The early cohort is served again at 50% (some of them now get "on"),
    // alongside a new cohort; only first exposures count.
    const again = await served(flag, users(`${flag}-a`, 10_000));
    const moved = again.filter((e, i) => e.variant !== early[i]!.variant);
    expect(moved.length).toBeGreaterThan(3000);
    for (const e of moved) expect(e.variant).toBe('on');
    await report(flag, [...again, ...(await served(flag, users(`${flag}-b`, 10_000)))]);

    const stored = await t.db
      .selectFrom('experiment_exposures')
      .select(['context_key', 'variant'])
      .where('flag_key', '=', flag)
      .execute();
    const firstVariant = new Map(stored.map((s) => [s.context_key, s.variant]));
    for (const e of early) expect(firstVariant.get(e.key)).toBe(e.variant);

    const after = await results(experiment);
    expect(after.exposed).toBe(20_000);
    expect(after.allocationChanged).toBe(true);
    expect(after.srm.mismatch).toBe(true);
    expect(after.warning).toMatchObject({ code: 'sample_ratio_mismatch' });
    expect(after.metrics).toBeNull();
  });
});
