import { evaluate, ROLLOUT_TOTAL, type RolloutGuard, type Ruleset } from '@flagship/core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../log.js';
import { createMetrics } from '../metrics.js';
import { testApp, type TestApp } from '../../test/app.js';
import { PASSWORD, signIn, userWithRole, type Client } from '../../test/session.js';
import type { RolledUpVariant } from './experimentRollup.js';
import { checkPlanGuards, GUARD_RECHECK_MS, readGuard, rolloutGuards } from './guards.js';

const guard = (patch: Partial<RolloutGuard> = {}): RolloutGuard => ({
  event: 'error',
  kind: 'conversion',
  worse: 'higher',
  threshold: 0,
  minContexts: 100,
  action: 'pause',
  ...patch,
});

/** A rolled-up row for a 0/1 metric: `converted` of `exposed` sent the event once. */
const rate = (variant: string, exposed: number, converted: number): RolledUpVariant => ({
  variant,
  exposed,
  converted,
  conversions: converted,
  value: converted,
  valueSquares: converted,
  conversionSquares: converted,
});
const sides = { variant: 'on', baseline: 'off' };

describe('readGuard', () => {
  it('waits until both sides have the minimum number of contexts', () => {
    const r = readGuard(guard({ minContexts: 500 }), sides, [
      rate('on', 499, 400),
      rate('off', 5000, 50),
    ]);
    expect(r.state).toBe('waiting');
    expect(r.variant).toEqual({ variant: 'on', exposed: 499, mean: 400 / 499 });
    expect(r.baseline.mean).toBeCloseTo(0.01);
    expect(r.lift).toBeGreaterThan(50);
    expect(readGuard(guard(), sides, [rate('off', 5000, 50)])).toMatchObject({
      state: 'waiting',
      variant: { exposed: 0, mean: null },
      lift: null,
      difference: null,
    });
  });

  it('breaches when the whole interval for the lift is past the threshold', () => {
    // 10% against 5%: a lift of 1 (100%), clearly above 0 and 0.5.
    const rows = [rate('on', 2000, 200), rate('off', 20_000, 1000)];
    const r = readGuard(guard(), sides, rows);
    expect(r.state).toBe('breached');
    expect(r.lift).toBeCloseTo(1);
    expect(r.liftInterval!.lower).toBeGreaterThan(0.5);
    expect(r.pValue).toBeLessThan(0.001);
    expect(readGuard(guard({ threshold: 0.5 }), sides, rows).state).toBe('breached');
    // A tolerated rise of 200% is not exceeded.
    expect(readGuard(guard({ threshold: 2 }), sides, rows).state).toBe('ok');
    // The same numbers are good news when lower is worse.
    expect(readGuard(guard({ worse: 'lower' }), sides, rows).state).toBe('ok');
  });

  it('does not breach on a difference the data cannot tell from noise', () => {
    // 6% against 5% on 300 contexts: the 99% interval reaches below 0.
    const r = readGuard(guard(), sides, [rate('on', 300, 18), rate('off', 3000, 150)]);
    expect(r.state).toBe('ok');
    expect(r.lift).toBeCloseTo(0.2);
    expect(r.liftInterval!.lower).toBeLessThan(0);
  });

  it('breaches a "lower is worse" guard on a confident drop past the threshold', () => {
    const rows = [rate('on', 4000, 400), rate('off', 4000, 800)];
    expect(readGuard(guard({ worse: 'lower' }), sides, rows).state).toBe('breached');
    expect(readGuard(guard({ worse: 'lower', threshold: 0.3 }), sides, rows).state).toBe(
      'breached',
    );
    expect(readGuard(guard({ worse: 'lower', threshold: 0.6 }), sides, rows).state).toBe('ok');
  });

  it('judges a rise from a zero baseline on the difference alone', () => {
    const rows = [rate('on', 1000, 30), rate('off', 1000, 0)];
    const r = readGuard(guard({ threshold: 5 }), sides, rows);
    expect(r.lift).toBeNull();
    expect(r.differenceInterval!.lower).toBeGreaterThan(0);
    expect(r.state).toBe('breached');
    expect(readGuard(guard({ worse: 'lower' }), sides, rows).state).toBe('ok');
    // Nothing on either side is no regression.
    expect(readGuard(guard(), sides, [rate('on', 1000, 0), rate('off', 1000, 0)]).state).toBe('ok');
  });

  it('reads counts and values per exposed context', () => {
    // Each converting context sent the event 5 times (count) worth 2 each (value).
    const heavy = (variant: string, exposed: number, converted: number): RolledUpVariant => ({
      variant,
      exposed,
      converted,
      conversions: converted * 5,
      conversionSquares: converted * 25,
      value: converted * 10,
      valueSquares: converted * 100,
    });
    const rows = [heavy('on', 1000, 300), heavy('off', 1000, 100)];
    const count = readGuard(guard({ kind: 'count' }), sides, rows);
    expect(count.variant.mean).toBeCloseTo(1.5);
    expect(count.baseline.mean).toBeCloseTo(0.5);
    expect(count.state).toBe('breached');
    const value = readGuard(guard({ kind: 'value', worse: 'lower' }), sides, rows);
    expect(value.variant.mean).toBeCloseTo(3);
    expect(value.state).toBe('ok');
    const dropped = [heavy('on', 1000, 100), heavy('off', 1000, 300)];
    expect(readGuard(guard({ kind: 'value', worse: 'lower' }), sides, dropped).state).toBe(
      'breached',
    );
  });
});

let t: TestApp;
let editor: Client;
let viewer: Client;
let envId: string;
let clock = new Date('2032-04-05T10:10:00Z');
let contexts = 0;

const P = '/api/projects/default';
const R = (flag: string) => `${P}/flags/${flag}/environments/production/rollout-plans`;
const minutes = (n: number) => {
  clock = new Date(clock.getTime() + n * 60_000);
};
const steps = [
  { weight: 10_000, holdMinutes: 600 },
  { weight: 50_000, holdMinutes: 600 },
  { weight: ROLLOUT_TOTAL },
];

async function newFlag(key: string) {
  const res = await editor.request('POST', `${P}/flags`, { key, name: key, type: 'boolean' });
  expect(res.statusCode, res.body).toBe(201);
  const on = await editor.request('POST', `${P}/flags/${key}/environments/production/kill-switch`, {
    enabled: true,
  });
  expect(on.statusCode, on.body).toBe(200);
}

async function start(key: string, guards: unknown[]) {
  const res = await editor.request('POST', R(key), {
    target: 'fallthrough',
    variant: 'on',
    baseline: 'off',
    steps,
    guards,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

async function plans(key: string) {
  return (await viewer.request('GET', R(key))).json().plans;
}

async function fallthrough(key: string) {
  const f = (await viewer.request('GET', `${P}/flags/${key}`)).json();
  return f.environments.production.fallthrough;
}

async function audit(key: string, action: string) {
  const entries = (await viewer.request('GET', `${P}/audit?flag=${key}&limit=200`)).json().entries;
  return entries.filter((e: { action: string }) => e.action === action);
}

/** `n` contexts first exposed to `variant` now, `converted` of which send `event` once. */
async function seed(flag: string, variant: string, n: number, converted: number, event = 'error') {
  const keys = Array.from({ length: n }, () => `ctx-${contexts++}`);
  await t.db
    .insertInto('experiment_exposures')
    .values(
      keys.map((k) => ({
        environment_id: envId,
        flag_key: flag,
        context_key: k,
        variant,
        first_at: clock,
      })),
    )
    .execute();
  if (converted > 0) {
    await t.db
      .insertInto('conversion_events')
      .values(
        keys.slice(0, converted).map((k) => ({
          environment_id: envId,
          id: `${k}-${event}`,
          event_key: event,
          context_key: k,
          value: null,
          occurred_at: new Date(clock.getTime() + 60_000),
          received_at: clock,
        })),
      )
      .execute();
  }
}

/** One housekeeping turn: the rollup, then the guards, as the scheduler runs them. */
const turn = () => t.app.scheduler.housekeep();

beforeAll(async () => {
  t = await testApp(
    {
      bootstrapAdmin: { email: 'root@example.com', password: PASSWORD },
      schedulerIntervalMs: 3_600_000,
      // Every housekeeping call runs the rollup, however little the clock moved.
      rollupIntervalMs: 0,
      sessionIdleMinutes: 100_000,
    },
    { now: () => clock },
  );
  await signIn(t.app.server, 'root@example.com');
  editor = await userWithRole(t.app.server, t.db, 'eddie@example.com', 'editor');
  viewer = await userWithRole(t.app.server, t.db, 'vera@example.com', 'viewer');
  const env = await t.db
    .selectFrom('environments')
    .innerJoin('projects', 'projects.id', 'environments.project_id')
    .select('environments.id')
    .where('projects.key', '=', 'default')
    .where('environments.key', '=', 'production')
    .executeTakeFirstOrThrow();
  envId = env.id;
});
afterAll(() => t.close());
afterEach(async () => {
  await t.db
    .updateTable('rollout_plans')
    .set({ status: 'cancelled', next_at: null, paused_reason: null, updated_at: clock })
    .where('status', 'in', ['active', 'paused'])
    .execute();
});

describe('guarded rollouts', () => {
  it('pause on a breach after the rollup, audited with the triggering values', async () => {
    await newFlag('guard-pause');
    const plan = await start('guard-pause', [{ event: 'error', minContexts: 200 }]);
    expect(plan.guardBreach).toBeNull();
    // 20% of the variant's contexts error against 5% of the baseline's.
    await seed('guard-pause', 'on', 300, 60);
    await seed('guard-pause', 'off', 3000, 150);
    minutes(5);
    await turn();

    const [paused] = await plans('guard-pause');
    expect(paused).toMatchObject({
      status: 'paused',
      pausedReason: 'guard',
      nextAt: null,
      step: 0,
      guardCheckedAt: clock.toISOString(),
    });
    expect(paused.guardBreach).toMatchObject({
      at: clock.toISOString(),
      step: 0,
      weight: 10_000,
      action: 'pause',
      rolledBack: false,
      note: null,
      from: plan.createdAt,
      confidence: 0.99,
    });
    const [reading] = paused.guardBreach.readings;
    expect(reading).toMatchObject({
      guard: { event: 'error', kind: 'conversion', worse: 'higher', threshold: 0, action: 'pause' },
      state: 'breached',
      variant: { variant: 'on', exposed: 300, mean: 0.2 },
      baseline: { variant: 'off', exposed: 3000, mean: 0.05 },
    });
    expect(reading.lift).toBeCloseTo(3);
    expect(reading.liftInterval.lower).toBeGreaterThan(0);

    // The serve stays on the step; pausing is all a pause guard does.
    expect(await fallthrough('guard-pause')).toEqual({
      rollout: {
        variants: [
          { variant: 'on', weight: 10_000 },
          { variant: 'off', weight: 90_000 },
        ],
      },
    });
    const [entry] = await audit('guard-pause', 'flag.rollout.guard');
    expect(entry.actor).toBe('Rollout guard on a plan by eddie');
    expect(entry.after).toMatchObject({
      plan: plan.id,
      action: 'pause',
      readings: [{ state: 'breached', variant: { exposed: 300, mean: 0.2 } }],
    });
    expect(await audit('guard-pause', 'flag.rollout.rollback')).toEqual([]);

    // The scheduler leaves a paused plan alone.
    minutes(700);
    await t.app.scheduler.runOnce();
    expect((await plans('guard-pause'))[0].step).toBe(0);
    const metrics = t.app.metrics.registry.render();
    expect(metrics).toMatch(/flagship_rollout_guard_checks_total\{result="paused"\} 1/);
  });

  it('judge a resumed plan only on contexts exposed after it resumed', async () => {
    await newFlag('guard-resume');
    const plan = await start('guard-resume', [{ event: 'error', minContexts: 200 }]);
    await seed('guard-resume', 'on', 300, 90);
    await seed('guard-resume', 'off', 3000, 150);
    await turn();
    expect((await plans('guard-resume'))[0].pausedReason).toBe('guard');

    const resumed = await editor.request('POST', `${R('guard-resume')}/${plan.id}/resume`, {});
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect(resumed.json()).toMatchObject({ status: 'active', guardBreach: null });
    const [resume] = await audit('guard-resume', 'flag.rollout.resume');
    expect(resume.after).toMatchObject({ plan: plan.id, pausedReason: 'guard' });
    const nextHour = new Date(Math.ceil(clock.getTime() / 3_600_000) * 3_600_000);
    const readings = await viewer.request('GET', `${R('guard-resume')}/${plan.id}/guards`);
    expect(readings.statusCode).toBe(200);
    expect(readings.json()).toMatchObject({
      plan: plan.id,
      from: nextHour.toISOString(),
      readings: [{ state: 'waiting', variant: { exposed: 0 }, baseline: { exposed: 0 } }],
    });

    // The old evidence no longer counts.
    minutes(1);
    await turn();
    expect((await plans('guard-resume'))[0].status).toBe('active');

    // Healthy contexts in the next hour keep it going.
    clock = new Date(nextHour.getTime() + 5 * 60_000);
    await seed('guard-resume', 'on', 300, 15);
    await seed('guard-resume', 'off', 3000, 150);
    await turn();
    const [healthy] = await plans('guard-resume');
    expect(healthy).toMatchObject({ status: 'active', guardCheckedAt: clock.toISOString() });

    // A fresh regression pauses it again.
    await seed('guard-resume', 'on', 600, 200);
    minutes(1);
    await turn();
    expect((await plans('guard-resume'))[0]).toMatchObject({
      status: 'paused',
      pausedReason: 'guard',
    });
  });

  it('roll the serve back to the baseline through the normal write path', async () => {
    await newFlag('guard-rollback');
    const plan = await start('guard-rollback', [
      { event: 'checkout', worse: 'lower', minContexts: 200 },
      { event: 'error', minContexts: 200, action: 'rollback' },
    ]);
    const before = (await viewer.request('GET', `${P}/environments/production/ruleset`)).json();
    await seed('guard-rollback', 'on', 400, 120);
    await seed('guard-rollback', 'off', 4000, 200);
    minutes(2);
    await turn();

    const [done] = await plans('guard-rollback');
    expect(done).toMatchObject({
      status: 'rolled_back',
      pausedReason: null,
      nextAt: null,
      finishedAt: clock.toISOString(),
    });
    expect(done.guardBreach).toMatchObject({ action: 'rollback', rolledBack: true, note: null });
    // Only the breached guard is in the breach; the checkout guard was fine.
    expect(done.guardBreach.readings.map((r: { guard: RolloutGuard }) => r.guard.event)).toEqual([
      'error',
    ]);
    expect(await fallthrough('guard-rollback')).toEqual({ variant: 'off' });

    // Published to SDKs like any edit: a new version that serves the baseline to everyone.
    const rs: Ruleset = (
      await viewer.request('GET', `${P}/environments/production/ruleset`)
    ).json();
    expect(rs.version).toBeGreaterThan(before.version);
    for (let i = 0; i < 200; i++) {
      expect(evaluate(rs, 'guard-rollback', { key: `user-${i}` })).toMatchObject({
        variant: 'off',
      });
    }
    const [write] = await audit('guard-rollback', 'flag.rollout.rollback');
    expect(write.actor).toBe('Rollout guard on a plan by eddie');
    expect(write.before.fallthrough.rollout).toBeDefined();
    expect(write.after.fallthrough).toEqual({ variant: 'off' });
    const [guardEntry] = await audit('guard-rollback', 'flag.rollout.guard');
    expect(guardEntry.after).toMatchObject({ plan: plan.id, action: 'rollback', rolledBack: true });

    // The flag is free for a new plan.
    const again = await editor.request('POST', R('guard-rollback'), {
      target: 'fallthrough',
      variant: 'on',
      baseline: 'off',
      steps,
    });
    expect(again.statusCode, again.body).toBe(201);
  });

  it('pause instead of rolling back over a hand edit to the serve', async () => {
    await newFlag('guard-edited');
    await start('guard-edited', [{ event: 'error', minContexts: 200, action: 'rollback' }]);
    const edited = { variant: 'on' };
    const current = (await viewer.request('GET', `${P}/flags/guard-edited`)).json().environments
      .production;
    const res = await editor.request('PUT', `${P}/flags/guard-edited/environments/production`, {
      version: current.version,
      enabled: true,
      offVariant: 'off',
      prerequisites: [],
      rules: [],
      fallthrough: edited,
    });
    expect(res.statusCode, res.body).toBe(200);
    await seed('guard-edited', 'on', 300, 90);
    await seed('guard-edited', 'off', 3000, 150);
    await turn();
    const [paused] = await plans('guard-edited');
    expect(paused).toMatchObject({ status: 'paused', pausedReason: 'guard' });
    expect(paused.guardBreach).toMatchObject({
      action: 'rollback',
      rolledBack: false,
      note: 'the targeted serve was edited after the step, so it was left alone',
    });
    expect(await fallthrough('guard-edited')).toEqual(edited);
    expect(await audit('guard-edited', 'flag.rollout.rollback')).toEqual([]);
  });

  it('keep rolling while healthy or short of the minimum, and show each guard’s reading', async () => {
    await newFlag('guard-healthy');
    const plan = await start('guard-healthy', [
      { event: 'error', minContexts: 200 },
      { event: 'latency', kind: 'count', minContexts: 5000 },
    ]);
    await seed('guard-healthy', 'on', 300, 15);
    await seed('guard-healthy', 'off', 3000, 150);
    await seed('guard-healthy', 'on', 300, 300, 'latency');
    await seed('guard-healthy', 'off', 3000, 0, 'latency');
    await turn();
    const [live] = await plans('guard-healthy');
    expect(live).toMatchObject({
      status: 'active',
      guardBreach: null,
      guardCheckedAt: clock.toISOString(),
    });
    const res = await viewer.request('GET', `${R('guard-healthy')}/${plan.id}/guards`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ plan: plan.id, from: plan.createdAt, confidence: 0.99 });
    expect(body.readings.map((r: { state: string }) => r.state)).toEqual(['ok', 'waiting']);
    expect(body.readings[0]).toMatchObject({
      variant: { exposed: 600, mean: 0.025 },
      baseline: { exposed: 6000, mean: 0.025 },
    });
    expect(body.readings[0].lift).toBeCloseTo(0);

    expect(
      (await viewer.request('GET', `${R('guard-healthy')}/${crypto.randomUUID()}/guards`))
        .statusCode,
    ).toBe(404);
    expect((await viewer.request('GET', `${R('guard-healthy')}/nope/guards`)).statusCode).toBe(400);
  });

  it('skip a plan another transaction holds, and check only touched or stale plans', async () => {
    await newFlag('guard-locks');
    const plan = await start('guard-locks', [{ event: 'error', minContexts: 200 }]);
    await seed('guard-locks', 'on', 300, 90);
    await seed('guard-locks', 'off', 3000, 150);
    // Roll up without the guards so the breach waits in the rollup.
    await t.app.scheduler.housekeep();
    await t.db
      .updateTable('rollout_plans')
      .set({
        status: 'active',
        paused_reason: null,
        next_at: clock,
        guard_checked_at: clock,
        guard_breach: null,
      })
      .where('id', '=', plan.id)
      .execute();

    const held = await t.db.startTransaction().execute();
    await held
      .selectFrom('rollout_plans')
      .select('id')
      .where('id', '=', plan.id)
      .forUpdate()
      .execute();
    expect(await checkPlanGuards(t.db, plan.id, { retention: 100, now: clock })).toBe('skipped');
    await held.rollback().execute();

    const check = rolloutGuards({
      db: t.db,
      metrics: createMetrics(),
      logger: createLogger('silent'),
      retention: 100,
    });
    // Checked a minute ago and no rollup touched it: not checked.
    minutes(1);
    expect(await check([], clock)).toBe(0);
    expect((await plans('guard-locks'))[0].status).toBe('active');
    // A rollup of another flag doesn't touch it either.
    expect(await check([{ environmentId: envId, flag: 'other', hour: clock }], clock)).toBe(0);
    // A rollup of its flag does.
    expect(await check([{ environmentId: envId, flag: 'guard-locks', hour: clock }], clock)).toBe(
      1,
    );
    expect((await plans('guard-locks'))[0].status).toBe('paused');

    // So does going unchecked for long enough.
    await t.db
      .updateTable('rollout_plans')
      .set({ status: 'active', paused_reason: null, next_at: clock, guard_breach: null })
      .where('id', '=', plan.id)
      .execute();
    minutes(GUARD_RECHECK_MS / 60_000 - 2);
    expect(await check([], clock)).toBe(0);
    minutes(3);
    expect(await check([], clock)).toBe(1);
  });

  it('check a stored plan that no longer parses without acting on it', async () => {
    await newFlag('guard-broken');
    const plan = await start('guard-broken', [{ event: 'error', minContexts: 200 }]);
    await t.db
      .updateTable('rollout_plans')
      .set({ plan: JSON.stringify({ ...plan.plan, guards: 'nonsense' }) })
      .where('id', '=', plan.id)
      .execute();
    expect(await checkPlanGuards(t.db, plan.id, { retention: 100, now: clock })).toBe('ok');
    const [row] = await plans('guard-broken');
    expect(row).toMatchObject({ status: 'active', guardCheckedAt: clock.toISOString() });
    const res = await viewer.request('GET', `${R('guard-broken')}/${plan.id}/guards`);
    expect(res.json().readings).toEqual([]);
  });

  it('log a failing check and go on to the next plan', async () => {
    await newFlag('guard-fails-1');
    await newFlag('guard-fails-2');
    const first = await start('guard-fails-1', [{ event: 'error', minContexts: 200 }]);
    const second = await start('guard-fails-2', [{ event: 'error', minContexts: 200 }]);
    await t.db
      .updateTable('rollout_plans')
      .set({ guard_checked_at: null })
      .where('id', 'in', [first.id, second.id])
      .execute();
    const logs: string[] = [];
    const metrics = createMetrics();
    // A database whose first transaction fails to start, as a dropped connection would.
    let failures = 1;
    const db = new Proxy(t.db, {
      get(target, prop) {
        if (prop === 'startTransaction' && failures-- > 0) {
          return () => ({ execute: () => Promise.reject(new Error('connection lost')) });
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    });
    const check = rolloutGuards({
      db,
      metrics,
      logger: createLogger('error', { write: (l: string) => void logs.push(l) }),
      retention: 100,
    });
    expect(await check([], clock)).toBe(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('rollout guard check failed');
    expect(metrics.registry.render()).toMatch(
      /flagship_rollout_guard_checks_total\{result="error"\} 1/,
    );
    expect(metrics.registry.render()).toMatch(
      /flagship_rollout_guard_checks_total\{result="ok"\} 1/,
    );
  });
});
