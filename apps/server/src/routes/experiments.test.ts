import { ROLLOUT_TOTAL } from '@flagship/core';
import {
  relativeLift,
  sampleRatioMismatch,
  studentTQuantile,
  welchTTest,
  wilsonInterval,
} from '@flagship/stats';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testApp, type TestApp } from '../../test/app.js';
import { PASSWORD, signIn, userWithRole, type Client } from '../../test/session.js';
import { createLogger } from '../log.js';
import { createMetrics } from '../metrics.js';
import {
  experimentWriter,
  type ConversionRecord,
  type ExposureRecord,
} from '../services/experimentEvents.js';
import { experimentRollup, rollupBacklog } from '../services/experimentRollup.js';

let t: TestApp;
let admin: Client;
let editor: Client;
let viewer: Client;
let env: string;
const START = Date.parse('2030-04-01T10:20:00Z');
let clock = new Date(START);

const P = '/api/projects/default';
const MIN = 60_000;
const HOUR = 60 * MIN;
const half = ROLLOUT_TOTAL / 2;
const split = (on = half) => ({
  rollout: {
    variants: [
      { variant: 'on', weight: on },
      { variant: 'off', weight: ROLLOUT_TOTAL - on },
    ],
  },
});

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

async function newFlag(key: string, fallthrough: unknown = split()) {
  const res = await editor.request('POST', `${P}/flags`, { key, name: key, type: 'boolean' });
  expect(res.statusCode, res.body).toBe(201);
  await targeting(key, { enabled: true, fallthrough });
}

const body = (flag: string, patch: Record<string, unknown> = {}) => ({
  key: `${flag}-test`,
  name: `${flag} test`,
  flag,
  environment: 'production',
  control: 'off',
  metrics: [{ event: 'purchase' }],
  ...patch,
});

async function start(flag: string, patch: Record<string, unknown> = {}) {
  const res = await editor.request('POST', `${P}/experiments`, body(flag, patch));
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

async function results(key: string, query = '') {
  const res = await viewer.request('GET', `${P}/experiments/${key}/results${query}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

let seq = 0;
interface Arm {
  variant: string;
  exposed: number;
  /** Value of each converting context's purchase, in context order; the rest never convert. */
  values: number[];
  /** Minutes after START of the exposures. */
  minutes?: number;
}

/** Writes exposures and one purchase per converting context, then rolls everything up. */
async function seed(flag: string, arms: Arm[]) {
  const exposures: ExposureRecord[] = [];
  const conversions: ConversionRecord[] = [];
  for (const arm of arms) {
    const at = START + (arm.minutes ?? 5) * MIN;
    for (let i = 0; i < arm.exposed; i++) {
      const key = `${flag}-${arm.variant}-${arm.minutes ?? 5}-${i}`;
      exposures.push({ environmentId: env, flag, key, variant: arm.variant, at });
      const value = arm.values[i];
      if (value !== undefined) {
        conversions.push({
          environmentId: env,
          id: `x-${String(++seq).padStart(10, '0')}`,
          event: 'purchase',
          key,
          value,
          at: at + 30 * MIN,
        });
      }
    }
  }
  await experimentWriter(t.db)({ exposures, conversions, receivedAt: new Date(START) });
  const job = experimentRollup({
    db: t.db,
    metrics: createMetrics(),
    logger: createLogger('silent'),
  });
  for (;;) {
    await job();
    const left = await rollupBacklog(t.db);
    if (left.hours === 0 && left.contexts === 0) break;
  }
}

/** Sample mean and (n − 1) variance of per-context values, zeros for those who never converted. */
function sample(arm: Arm) {
  const xs = Array.from({ length: arm.exposed }, (_, i) => arm.values[i] ?? 0);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
  return { n: xs.length, mean, variance };
}

beforeAll(async () => {
  t = await testApp(
    {
      bootstrapAdmin: { email: 'root@example.com', password: PASSWORD },
      schedulerIntervalMs: 3_600_000,
      eventsFlushMs: 3_600_000,
      sessionIdleMinutes: 10_080,
    },
    { now: () => clock },
  );
  admin = await signIn(t.app.server, 'root@example.com');
  editor = await userWithRole(t.app.server, t.db, 'eddie@example.com', 'editor');
  viewer = await userWithRole(t.app.server, t.db, 'vera@example.com', 'viewer');
  env = (
    await t.db
      .selectFrom('environments')
      .select('id')
      .where('key', '=', 'production')
      .executeTakeFirstOrThrow()
  ).id;
});
afterAll(() => t.close());
beforeEach(() => {
  clock = new Date(START);
});

describe('experiments', () => {
  it('start on the live split, record it, and are audited on the flag', async () => {
    await newFlag('checkout', split(30_000));
    const res = await editor.request(
      'POST',
      `${P}/experiments`,
      body('checkout', {
        hypothesis: 'A shorter checkout sells more',
        metrics: [{ event: 'purchase' }, { event: 'purchase', kind: 'value' }],
      }),
      { headers: { 'flagship-reason': encodeURIComponent('Q3 checkout test') } },
    );
    expect(res.statusCode, res.body).toBe(201);
    const started = res.json();
    expect(started).toMatchObject({
      key: 'checkout-test',
      name: 'checkout test',
      hypothesis: 'A shorter checkout sells more',
      flag: 'checkout',
      environment: 'production',
      target: 'fallthrough',
      allocation: split(30_000).rollout,
      control: 'off',
      metrics: [
        { event: 'purchase', kind: 'conversion' },
        { event: 'purchase', kind: 'value' },
      ],
      status: 'running',
      startedAt: clock.toISOString(),
      stoppedAt: null,
      createdBy: 'eddie',
    });
    expect((await viewer.request('GET', `${P}/experiments/checkout-test`)).json()).toEqual(started);
    const audit = (await viewer.request('GET', `${P}/audit?flag=checkout`)).json().entries;
    expect(audit[0]).toMatchObject({
      action: 'flag.experiment.start',
      actor: 'eddie',
      reason: 'Q3 checkout test',
    });
  });

  it('refuse what they cannot measure', async () => {
    await newFlag('plain', { variant: 'on' });
    const notSplit = await editor.request('POST', `${P}/experiments`, body('plain'));
    expect(notSplit.statusCode).toBe(409);
    expect(notSplit.json().error.message).toMatch(/not a percentage rollout/);

    await newFlag('lopsided', {
      rollout: {
        variants: [
          { variant: 'on', weight: ROLLOUT_TOTAL },
          { variant: 'off', weight: 0 },
        ],
      },
    });
    const noControl = await editor.request('POST', `${P}/experiments`, body('lopsided'));
    expect(noControl.statusCode).toBe(409);
    expect(noControl.json().error.message).toMatch(/control variant "off" gets no traffic/);
    const oneArm = await editor.request(
      'POST',
      `${P}/experiments`,
      body('lopsided', { control: 'on' }),
    );
    expect(oneArm.statusCode).toBe(409);
    expect(oneArm.json().error.message).toMatch(/only one variant/);

    await newFlag('ruled');
    const noRule = await editor.request(
      'POST',
      `${P}/experiments`,
      body('ruled', { target: { rule: 'beta' } }),
    );
    expect(noRule.statusCode).toBe(409);
    expect(noRule.json().error.message).toMatch(/rule does not exist/);
    const badControl = await editor.request(
      'POST',
      `${P}/experiments`,
      body('ruled', { control: 'maybe' }),
    );
    expect(badControl.statusCode).toBe(400);
    expect(badControl.json().error.details).toEqual([
      { path: 'control', message: 'flag "ruled" has no variant "maybe"' },
    ]);
    const dupMetric = await editor.request(
      'POST',
      `${P}/experiments`,
      body('ruled', {
        metrics: [{ event: 'purchase' }, { event: 'purchase', kind: 'conversion' }],
      }),
    );
    expect(dupMetric.statusCode).toBe(400);
    const noMetric = await editor.request(
      'POST',
      `${P}/experiments`,
      body('ruled', { metrics: [] }),
    );
    expect(noMetric.statusCode).toBe(400);
    expect((await editor.request('POST', `${P}/experiments`, body('nope'))).statusCode).toBe(404);
    expect(
      (await editor.request('POST', `${P}/experiments`, body('ruled', { environment: 'mars' })))
        .statusCode,
    ).toBe(404);
    expect((await viewer.request('POST', `${P}/experiments`, body('ruled'))).statusCode).toBe(403);
    expect((await viewer.request('GET', `${P}/experiments/none`)).statusCode).toBe(404);
  });

  it('read a rule split when targeted at one', async () => {
    await newFlag('beta-flag', { variant: 'off' });
    await targeting('beta-flag', {
      rules: [
        {
          id: 'beta',
          clauses: [{ attribute: 'plan', operator: 'in', values: ['beta'] }],
          serve: split(20_000),
        },
      ],
    });
    const started = await start('beta-flag', { target: { rule: 'beta' } });
    expect(started.target).toEqual({ rule: 'beta' });
    expect(started.allocation).toEqual(split(20_000).rollout);
  });

  it('allow one running experiment per flag and environment, and unique keys', async () => {
    await newFlag('solo');
    await start('solo');
    const again = await editor.request('POST', `${P}/experiments`, body('solo', { key: 'solo-2' }));
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatchObject({
      message: expect.stringMatching(/already has a running experiment/),
      details: { experiment: 'solo-test' },
    });
    await newFlag('solo-other');
    const sameKey = await editor.request(
      'POST',
      `${P}/experiments`,
      body('solo-other', { key: 'solo-test' }),
    );
    expect(sameKey.statusCode).toBe(409);
    expect(sameKey.json().error.message).toBe('experiment "solo-test" already exists');

    clock = new Date(START + 2 * HOUR);
    const stopped = await editor.request('POST', `${P}/experiments/solo-test/stop`, {});
    expect(stopped.statusCode, stopped.body).toBe(200);
    expect(stopped.json()).toMatchObject({
      status: 'stopped',
      stoppedAt: clock.toISOString(),
      stoppedReason: 'manual',
    });
    const twice = await editor.request('POST', `${P}/experiments/solo-test/stop`, {});
    expect(twice.statusCode).toBe(409);
    expect((await viewer.request('POST', `${P}/experiments/solo-test/stop`, {})).statusCode).toBe(
      403,
    );
    await start('solo', { key: 'solo-2' });
    const audit = (await viewer.request('GET', `${P}/audit?flag=solo`)).json().entries;
    expect(audit.map((e: { action: string }) => e.action).slice(0, 3)).toEqual([
      'flag.experiment.start',
      'flag.experiment.stop',
      'flag.experiment.start',
    ]);
  });

  it('list by environment, flag and status, newest first', async () => {
    await newFlag('listed');
    await start('listed', { key: 'listed-a' });
    clock = new Date(START + MIN);
    await editor.request('POST', `${P}/experiments/listed-a/stop`, {});
    await start('listed', { key: 'listed-b' });
    const list = async (q: string) =>
      (await viewer.request('GET', `${P}/experiments?${q}`))
        .json()
        .experiments.map((e: { key: string }) => e.key);
    expect(await list('flag=listed')).toEqual(['listed-b', 'listed-a']);
    expect(await list('flag=listed&status=running')).toEqual(['listed-b']);
    expect(await list('flag=listed&status=stopped&environment=production')).toEqual(['listed-a']);
    expect(await list('flag=listed&environment=development')).toEqual([]);
    expect(await list('flag=listed&limit=1')).toEqual(['listed-b']);
    expect((await viewer.request('GET', `${P}/experiments?status=paused`)).statusCode).toBe(400);
    expect((await viewer.request('GET', `${P}/experiments?environment=mars`)).statusCode).toBe(404);
  });

  it('honour the environment reason rule on start and stop', async () => {
    await newFlag('noted');
    const policy = async (requireReason: boolean) => {
      const res = await admin.request('PUT', `${P}/environments/production/change-notes`, {
        requireReason,
        requireLink: false,
      });
      expect(res.statusCode, res.body).toBe(200);
    };
    await policy(true);
    try {
      const bare = await editor.request('POST', `${P}/experiments`, body('noted'));
      expect(bare.statusCode).toBe(400);
      const withReason = { headers: { 'flagship-reason': 'measure it' } };
      const ok = await editor.request('POST', `${P}/experiments`, body('noted'), withReason);
      expect(ok.statusCode, ok.body).toBe(201);
      expect(
        (await editor.request('POST', `${P}/experiments/noted-test/stop`, {})).statusCode,
      ).toBe(400);
      const stop = await editor.request('POST', `${P}/experiments/noted-test/stop`, {}, withReason);
      expect(stop.statusCode).toBe(200);
    } finally {
      await policy(false);
    }
  });

  it('report per-variant rates and values with 95% intervals and lift for a known effect', async () => {
    await newFlag('effect');
    await start('effect', {
      metrics: [
        { event: 'purchase' },
        { event: 'purchase', kind: 'value' },
        { event: 'purchase', kind: 'count' },
        { event: 'signup' },
      ],
    });
    const price = (i: number) => 20 + (i % 7) * 5;
    const control: Arm = { variant: 'off', exposed: 2000, values: [] };
    const treatment: Arm = { variant: 'on', exposed: 2000, values: [] };
    for (let i = 0; i < 200; i++) control.values.push(price(i)); // 10%
    for (let i = 0; i < 300; i++) treatment.values.push(price(i)); // 15%
    await seed('effect', [control, treatment]);

    const r = await results('effect-test');
    expect(r.window).toEqual({ from: '2030-04-01T10:00:00.000Z', to: null });
    expect(r.confidence).toBe(0.95);
    expect(r.exposed).toBe(4000);
    expect(r.allocationChanged).toBe(false);
    expect(r.warning).toBeNull();
    expect(r.variants).toEqual([
      { variant: 'off', weight: half, exposed: 2000, expected: 2000 },
      { variant: 'on', weight: half, exposed: 2000, expected: 2000 },
    ]);
    expect(r.srm).toMatchObject({
      statistic: 0,
      df: 1,
      pValue: 1,
      mismatch: false,
      threshold: 0.001,
    });

    const [rate, value, count, signup] = r.metrics;
    expect(rate.kind).toBe('conversion');
    const [off, on] = rate.variants;
    expect(off).toMatchObject({ variant: 'off', exposed: 2000, converted: 200, conversions: 200 });
    expect(off.mean).toBeCloseTo(0.1, 12);
    expect(on.mean).toBeCloseTo(0.15, 12);
    expect(off.interval).toEqual(wilsonInterval(200, 2000));
    expect(on.interval).toEqual(wilsonInterval(300, 2000));
    expect(off.interval.lower).toBeCloseTo(0.0876, 3);
    expect(off.interval.upper).toBeCloseTo(0.1139, 3);
    expect(off.comparison).toBeNull();
    const rc = { n: 2000, mean: 0.1, variance: (2000 * 0.1 * 0.9) / 1999 };
    const rt = { n: 2000, mean: 0.15, variance: (2000 * 0.15 * 0.85) / 1999 };
    const welch = welchTTest(rc, rt)!;
    const lift = relativeLift(rc, rt)!;
    expect(on.comparison.difference).toBeCloseTo(0.05, 12);
    expect(on.comparison.differenceInterval.lower).toBeCloseTo(welch.interval.lower, 10);
    expect(on.comparison.differenceInterval.upper).toBeCloseTo(welch.interval.upper, 10);
    expect(on.comparison.lift).toBeCloseTo(0.5, 12);
    expect(on.comparison.liftInterval.lower).toBeCloseTo(lift.interval.lower, 10);
    expect(on.comparison.liftInterval.upper).toBeCloseTo(lift.interval.upper, 10);
    expect(on.comparison.pValue).toBeCloseTo(welch.pValue, 12);
    // 10% against 15% on 2,000 each: z ≈ 4.8, far past 95%.
    expect(on.comparison.pValue).toBeLessThan(1e-5);
    expect(on.comparison.significant).toBe(true);
    expect(on.comparison.differenceInterval.lower).toBeGreaterThan(0);

    expect(value.kind).toBe('value');
    const sc = sample(control);
    const st = sample(treatment);
    const [vOff, vOn] = value.variants;
    expect(vOff.value).toBe(control.values.reduce((a, b) => a + b, 0));
    expect(vOff.mean).toBeCloseTo(sc.mean, 10);
    expect(vOn.mean).toBeCloseTo(st.mean, 10);
    const t95 = studentTQuantile(0.975, 1999);
    expect(vOff.interval.lower).toBeCloseTo(sc.mean - t95 * Math.sqrt(sc.variance / 2000), 8);
    expect(vOff.interval.upper).toBeCloseTo(sc.mean + t95 * Math.sqrt(sc.variance / 2000), 8);
    const vWelch = welchTTest(sc, st)!;
    expect(vOn.comparison.pValue).toBeCloseTo(vWelch.pValue, 10);
    expect(vOn.comparison.lift).toBeCloseTo(st.mean / sc.mean - 1, 10);

    expect(count.kind).toBe('count');
    expect(count.variants[1].mean).toBeCloseTo(0.15, 12);

    // An event nobody sent: zero rates with intervals at 0 and no lift.
    expect(signup.variants[0]).toMatchObject({ converted: 0, mean: 0, interval: { lower: 0 } });
    expect(signup.variants[1].comparison).toMatchObject({
      difference: 0,
      lift: null,
      liftInterval: null,
      pValue: 1,
      significant: false,
    });
  });

  it('hide results behind a warning when the sample ratio check fails', async () => {
    await newFlag('biased');
    await start('biased');
    // 2,000 against 2,300 on a 50/50 split: chi-square ≈ 20.9, p ≈ 5e-6.
    await seed('biased', [
      { variant: 'off', exposed: 2000, values: Array(200).fill(1) },
      { variant: 'on', exposed: 2300, values: Array(240).fill(1) },
    ]);
    const r = await results('biased-test');
    const expected = sampleRatioMismatch([2000, 2300], [1, 1]);
    expect(r.srm.mismatch).toBe(true);
    expect(r.srm.statistic).toBeCloseTo(expected.statistic, 10);
    expect(r.srm.pValue).toBeCloseTo(expected.pValue, 15);
    expect(r.srm.pValue).toBeLessThan(0.001);
    expect(r.warning).toMatchObject({ code: 'sample_ratio_mismatch' });
    expect(r.warning.message).toMatch(/below 0\.001/);
    expect(r.metrics).toBeNull();
    expect(r.variants.map((v: { exposed: number }) => v.exposed)).toEqual([2000, 2300]);

    const shown = await results('biased-test', '?showMismatched=true');
    expect(shown.srm.mismatch).toBe(true);
    expect(shown.warning).toBeNull();
    expect(shown.metrics[0].variants[0].mean).toBeCloseTo(0.1, 12);
    expect(
      (await viewer.request('GET', `${P}/experiments/biased-test/results?showMismatched=yes`))
        .statusCode,
    ).toBe(400);
  });

  it('keep a fair split visible even when the counts differ by chance', async () => {
    await newFlag('fair');
    await start('fair');
    // 2,000 against 2,060: chi-square ≈ 0.89, p ≈ 0.35.
    await seed('fair', [
      { variant: 'off', exposed: 2000, values: [] },
      { variant: 'on', exposed: 2060, values: [] },
    ]);
    const r = await results('fair-test');
    expect(r.srm.mismatch).toBe(false);
    expect(r.srm.pValue).toBeGreaterThan(0.3);
    expect(r.warning).toBeNull();
    expect(r.metrics).toHaveLength(1);
  });

  it('flag a variant the split never served as a certain mismatch', async () => {
    await newFlag('three', {
      rollout: {
        variants: [
          { variant: 'on', weight: half },
          { variant: 'off', weight: half },
        ],
      },
    });
    await start('three');
    await seed('three', [
      { variant: 'off', exposed: 50, values: [] },
      { variant: 'on', exposed: 50, values: [] },
      { variant: 'rogue', exposed: 1, values: [] },
    ]);
    const r = await results('three-test');
    expect(
      r.variants.map((v: { variant: string; weight: number }) => [v.variant, v.weight]),
    ).toEqual([
      ['off', half],
      ['on', half],
      ['rogue', 0],
    ]);
    expect(r.srm).toMatchObject({ mismatch: true, pValue: 0 });
    expect(r.metrics).toBeNull();
  });

  it('count only contexts first exposed from the start hour to the stop hour', async () => {
    await newFlag('windowed');
    await start('windowed');
    await seed('windowed', [
      // Before the start hour: not counted.
      { variant: 'off', exposed: 7, values: [1], minutes: -30 },
      // Inside the start hour, before and after the start: counted.
      { variant: 'off', exposed: 5, values: [], minutes: -10 },
      { variant: 'on', exposed: 4, values: [1, 1], minutes: 10 },
      // The stop hour: counted. The hour after it: not.
      { variant: 'off', exposed: 3, values: [], minutes: 160 },
      { variant: 'on', exposed: 9, values: [], minutes: 230 },
    ]);
    clock = new Date(START + 3 * HOUR); // 13:20, so the 13:00 hour is the last one
    await editor.request('POST', `${P}/experiments/windowed-test/stop`, {});
    const r = await results('windowed-test');
    expect(r.window).toEqual({ from: '2030-04-01T10:00:00.000Z', to: '2030-04-01T14:00:00.000Z' });
    expect(r.variants.map((v: { exposed: number }) => v.exposed)).toEqual([8, 4]);
    expect(r.metrics[0].variants[1]).toMatchObject({ exposed: 4, converted: 2 });
  });

  it('report when the live split no longer matches the allocation', async () => {
    await newFlag('drift');
    await start('drift');
    expect((await results('drift-test')).allocationChanged).toBe(false);
    await targeting('drift', { fallthrough: split(60_000) });
    expect((await results('drift-test')).allocationChanged).toBe(true);
  });

  it('stop when their flag is archived', async () => {
    await newFlag('retired');
    await start('retired');
    const f = (await viewer.request('GET', `${P}/flags/retired`)).json();
    const res = await editor.request('POST', `${P}/flags/retired/archive`, { version: f.version });
    expect(res.statusCode, res.body).toBe(200);
    const e = (await viewer.request('GET', `${P}/experiments/retired-test`)).json();
    expect(e).toMatchObject({ status: 'stopped', stoppedReason: 'flag archived' });
    // The app clock is ahead of the wall clock here; the stop never precedes the start.
    expect(Date.parse(e.stoppedAt)).toBeGreaterThanOrEqual(Date.parse(e.startedAt));
    const again = await editor.request('POST', `${P}/experiments`, body('retired', { key: 'r2' }));
    expect(again.statusCode).toBe(400);
    expect(again.json().error.message).toBe('flag "retired" is archived');
  });
});
