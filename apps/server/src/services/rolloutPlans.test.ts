import { evaluate, ROLLOUT_TOTAL, type Ruleset } from '@flagship/core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../app.js';
import { createDatabase } from '../db/database.js';
import { createLogger } from '../log.js';
import { testApp, type TestApp } from '../../test/app.js';
import { PASSWORD, signIn, userWithRole, type Client } from '../../test/session.js';

let t: TestApp;
let admin: Client;
let editor: Client;
let viewer: Client;
let clock = new Date('2030-06-01T09:00:00Z');

const P = '/api/projects/default';
const R = (flag: string, env = 'production') =>
  `${P}/flags/${flag}/environments/${env}/rollout-plans`;
const minutes = (n: number) => {
  clock = new Date(clock.getTime() + n * 60_000);
};

const steps = [
  { weight: 1_000, holdMinutes: 60 },
  { weight: 10_000, holdMinutes: 30 },
  { weight: 50_000, holdMinutes: 30 },
  { weight: ROLLOUT_TOTAL },
];
const plan = (patch: Record<string, unknown> = {}) => ({
  target: 'fallthrough',
  variant: 'on',
  baseline: 'off',
  steps,
  ...patch,
});

async function flag(key: string) {
  return (await viewer.request('GET', `${P}/flags/${key}`)).json();
}

async function newFlag(key: string, enabled = true) {
  const res = await editor.request('POST', `${P}/flags`, { key, name: key, type: 'boolean' });
  expect(res.statusCode, res.body).toBe(201);
  if (enabled) {
    const on = await editor.request(
      'POST',
      `${P}/flags/${key}/environments/production/kill-switch`,
      {
        enabled: true,
      },
    );
    expect(on.statusCode, on.body).toBe(200);
  }
}

async function start(key: string, body: unknown = plan()) {
  const res = await editor.request('POST', R(key), body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

async function plans(key: string) {
  return (await viewer.request('GET', R(key))).json().plans;
}

async function act(key: string, id: string, action: string, c: Client = editor) {
  return c.request('POST', `${R(key)}/${id}/${action}`, {});
}

async function audit(key: string, action: string) {
  const entries = (await viewer.request('GET', `${P}/audit?flag=${key}&limit=200`)).json().entries;
  return entries.filter((e: { action: string }) => e.action === action);
}

async function ruleset(): Promise<Ruleset> {
  return (await viewer.request('GET', `${P}/environments/production/ruleset`)).json();
}

beforeAll(async () => {
  t = await testApp(
    {
      bootstrapAdmin: { email: 'root@example.com', password: PASSWORD },
      schedulerIntervalMs: 3_600_000,
      // The clock moves hours at a time; keep the test sessions signed in.
      sessionIdleMinutes: 10_080,
    },
    { now: () => clock },
  );
  admin = await signIn(t.app.server, 'root@example.com');
  editor = await userWithRole(t.app.server, t.db, 'eddie@example.com', 'editor');
  viewer = await userWithRole(t.app.server, t.db, 'vera@example.com', 'viewer');
});
afterAll(() => t.close());
// Each test counts the steps it causes, so plans left running are finished here.
afterEach(async () => {
  await t.db
    .updateTable('rollout_plans')
    .set({ status: 'cancelled', next_at: null, paused_reason: null, updated_at: clock })
    .where('status', 'in', ['active', 'paused'])
    .execute();
});

describe('rollout plans', () => {
  it('apply the first step on start, then each later step once its hold has passed', async () => {
    await newFlag('ramp');
    const before = await flag('ramp');
    const started = await start('ramp');
    expect(started).toMatchObject({
      status: 'active',
      step: 0,
      weight: 1_000,
      nextAt: new Date(clock.getTime() + 60 * 60_000).toISOString(),
      pausedReason: null,
      createdBy: 'eddie',
    });
    const live = await flag('ramp');
    expect(live.environments.production.fallthrough).toEqual({
      rollout: {
        variants: [
          { variant: 'on', weight: 1_000 },
          { variant: 'off', weight: 99_000 },
        ],
      },
    });
    expect(live.environments.production.version).toBe(before.environments.production.version + 1);
    expect(await audit('ramp', 'flag.rollout.start')).toHaveLength(1);

    minutes(59);
    expect(await t.app.scheduler.runOnce()).toBe(0);
    minutes(1);
    expect(await t.app.scheduler.runOnce()).toBe(1);
    expect((await plans('ramp'))[0]).toMatchObject({ status: 'active', step: 1, weight: 10_000 });

    // The hold is the one of the step just applied (30 minutes), not the first.
    minutes(30);
    expect(await t.app.scheduler.runOnce()).toBe(1);
    minutes(30);
    expect(await t.app.scheduler.runOnce()).toBe(1);
    const done = (await plans('ramp'))[0];
    expect(done).toMatchObject({
      status: 'completed',
      step: 3,
      weight: ROLLOUT_TOTAL,
      nextAt: null,
    });
    expect(done.finishedAt).toBe(clock.toISOString());
    expect((await flag('ramp')).environments.production.fallthrough).toEqual({ variant: 'on' });
    minutes(600);
    expect(await t.app.scheduler.runOnce()).toBe(0);

    const stepEntries = await audit('ramp', 'flag.rollout.step');
    expect(stepEntries).toHaveLength(4);
    expect(stepEntries[0].actor).toBe('Rollout by eddie');
    expect(stepEntries.at(-1).actor).toBe('eddie');
    expect(t.app.metrics.rolloutSteps.get({ result: 'applied' })).toBe(2);
    expect(t.app.metrics.rolloutSteps.get({ result: 'completed' })).toBe(1);
  });

  it('keeps every context that got the variant on it at every later step', async () => {
    await newFlag('sticky');
    await start('sticky', plan({ bucketBy: 'org' }));
    const contexts = Array.from({ length: 3000 }, (_, i) => ({
      key: `user-${i}`,
      org: `org-${i % 700}`,
    }));
    let had = new Set<string>();
    for (let step = 0; step < steps.length; step++) {
      const rs = await ruleset();
      const on = new Set(
        contexts
          .filter((c) => {
            const e = evaluate(rs, 'sticky', c);
            return 'variant' in e && e.variant === 'on';
          })
          .map((c) => c.key),
      );
      for (const key of had) expect(on.has(key)).toBe(true);
      // Bucketing by org keeps a company together at every step.
      for (const c of contexts) {
        const peer = contexts.find((o) => o.org === c.org && o.key !== c.key);
        if (peer !== undefined) expect(on.has(c.key)).toBe(on.has(peer.key));
      }
      if (step < steps.length - 1) {
        const share = on.size / contexts.length;
        expect(Math.abs(share - (steps[step]?.weight ?? 0) / ROLLOUT_TOTAL)).toBeLessThan(0.06);
      }
      had = on;
      minutes(60);
      await t.app.scheduler.runOnce();
    }
    expect(had.size).toBe(contexts.length);
  });

  it('applies each step exactly once when two instances race for it', async () => {
    await newFlag('race');
    await start('race');
    const { db } = createDatabase({ url: t.url, maxConnections: 5 });
    const other: App = await buildApp({
      config: t.config,
      db,
      logger: createLogger('silent'),
      now: () => clock,
    });
    try {
      for (let i = 1; i < steps.length; i++) {
        minutes(60);
        const [a, b] = await Promise.all([t.app.scheduler.runOnce(), other.scheduler.runOnce()]);
        expect(a + b).toBe(1);
        expect((await plans('race'))[0].step).toBe(i);
      }
      // Racing again after the end does nothing.
      minutes(60);
      const [a, b] = await Promise.all([t.app.scheduler.runOnce(), other.scheduler.runOnce()]);
      expect(a + b).toBe(0);
    } finally {
      await other.close();
      await db.destroy();
    }
    expect(await audit('race', 'flag.rollout.step')).toHaveLength(steps.length);
    expect((await plans('race'))[0].status).toBe('completed');
  });

  it('pauses on the kill switch, stays paused when it is turned back on, and resumes on request', async () => {
    await newFlag('kill');
    const p = await start('kill');
    const off = await editor.request(
      'POST',
      `${P}/flags/kill/environments/production/kill-switch`,
      {
        enabled: false,
      },
    );
    expect(off.statusCode).toBe(200);
    expect((await plans('kill'))[0]).toMatchObject({
      status: 'paused',
      pausedReason: 'kill_switch',
      nextAt: null,
      step: 0,
    });
    const pauses = await audit('kill', 'flag.rollout.pause');
    expect(pauses).toHaveLength(1);
    expect(pauses[0].actor).toBe('eddie');

    minutes(120);
    expect(await t.app.scheduler.runOnce()).toBe(0);
    const whileOff = await act('kill', p.id, 'resume');
    expect(whileOff.statusCode).toBe(409);
    expect(whileOff.json().error.message).toContain('turn it on before resuming');

    await editor.request('POST', `${P}/flags/kill/environments/production/kill-switch`, {
      enabled: true,
    });
    minutes(120);
    expect(await t.app.scheduler.runOnce()).toBe(0);
    expect((await plans('kill'))[0].status).toBe('paused');

    const resumed = await act('kill', p.id, 'resume');
    expect(resumed.statusCode, resumed.body).toBe(200);
    // Resuming restarts the hold of the current step.
    expect(resumed.json()).toMatchObject({
      status: 'active',
      pausedReason: null,
      nextAt: new Date(clock.getTime() + 60 * 60_000).toISOString(),
    });
    minutes(60);
    expect(await t.app.scheduler.runOnce()).toBe(1);
    expect((await plans('kill'))[0].step).toBe(1);
  });

  it('pauses instead of stepping when the scheduler finds the flag off', async () => {
    // A write path that turned the flag off without the plan seeing it, such as an import.
    await newFlag('backstop');
    await start('backstop');
    await t.db
      .updateTable('flag_configs')
      .set({ enabled: false })
      .where('flag_id', '=', (await flagId('backstop')).id)
      .execute();
    minutes(60);
    expect(await t.app.scheduler.runOnce()).toBe(1);
    expect((await plans('backstop'))[0]).toMatchObject({
      status: 'paused',
      pausedReason: 'kill_switch',
      step: 0,
    });
    expect(t.app.metrics.rolloutSteps.get({ result: 'paused' })).toBeGreaterThan(0);
  });

  it('pauses rather than overwrite a hand edit to the targeted serve, and will not resume over it', async () => {
    await newFlag('edited');
    const p = await start('edited');
    const current = (await flag('edited')).environments.production;
    const put = await editor.request('PUT', `${P}/flags/edited/environments/production`, {
      version: current.version,
      enabled: true,
      offVariant: 'off',
      prerequisites: [],
      rules: [],
      fallthrough: { variant: 'off' },
    });
    expect(put.statusCode, put.body).toBe(200);
    minutes(60);
    expect(await t.app.scheduler.runOnce()).toBe(1);
    expect((await plans('edited'))[0]).toMatchObject({ status: 'paused', pausedReason: 'edited' });
    expect((await flag('edited')).environments.production.fallthrough).toEqual({ variant: 'off' });
    const resume = await act('edited', p.id, 'resume');
    expect(resume.statusCode).toBe(409);
    expect(resume.json().error.message).toContain('edited after this step');

    const cancelled = await act('edited', p.id, 'cancel');
    expect(cancelled.json()).toMatchObject({ status: 'cancelled', pausedReason: null });
    // A new plan can start once the old one is finished.
    await start('edited');
  });

  it('steps a rule’s serve and fails when that rule is deleted', async () => {
    await newFlag('ruled');
    const current = (await flag('ruled')).environments.production;
    const rules = [
      {
        id: 'beta',
        clauses: [{ attribute: 'plan', operator: 'equals', values: ['beta'] }],
        serve: { variant: 'off' },
      },
    ];
    await editor.request('PUT', `${P}/flags/ruled/environments/production`, {
      version: current.version,
      enabled: true,
      offVariant: 'off',
      prerequisites: [],
      rules,
      fallthrough: { variant: 'off' },
    });
    const missing = await editor.request('POST', R('ruled'), plan({ target: { rule: 'gone' } }));
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.details).toEqual([
      { path: 'target.rule', message: 'unknown rule "gone"' },
    ]);
    await start('ruled', plan({ target: { rule: 'beta' } }));
    const live = (await flag('ruled')).environments.production;
    expect(live.rules[0].serve.rollout.variants[0]).toEqual({ variant: 'on', weight: 1_000 });
    expect(live.fallthrough).toEqual({ variant: 'off' });

    await editor.request('PUT', `${P}/flags/ruled/environments/production`, {
      version: live.version,
      enabled: true,
      offVariant: 'off',
      prerequisites: [],
      rules: [],
      fallthrough: { variant: 'off' },
    });
    minutes(60);
    expect(await t.app.scheduler.runOnce()).toBe(1);
    expect((await plans('ruled'))[0]).toMatchObject({
      status: 'failed',
      error: 'rule "beta" no longer exists',
    });
  });

  it('fails a step that no longer validates and leaves the targeting alone', async () => {
    await newFlag('broken');
    await start('broken');
    const id = (await flagId('broken')).id;
    // Targeting that a write would refuse, put in place behind the API's back.
    await t.db
      .updateTable('flag_configs')
      .set({
        rules: JSON.stringify([
          {
            id: 'ghost',
            clauses: [{ operator: 'inSegment', segments: ['nobody'] }],
            serve: { variant: 'on' },
          },
        ]),
      })
      .where('flag_id', '=', id)
      .execute();
    const before = (await flag('broken')).environments.production;
    minutes(60);
    expect(await t.app.scheduler.runOnce()).toBe(1);
    const failed = (await plans('broken'))[0];
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('unknown segment "nobody"');
    expect((await flag('broken')).environments.production.version).toBe(before.version);
    await t.db.updateTable('flag_configs').set({ rules: '[]' }).where('flag_id', '=', id).execute();
  });

  it('pauses, resumes and cancels by hand and refuses moves that do not apply', async () => {
    await newFlag('manual');
    const p = await start('manual');
    expect((await act('manual', p.id, 'resume')).statusCode).toBe(409);
    const paused = await act('manual', p.id, 'pause');
    expect(paused.json()).toMatchObject({ status: 'paused', pausedReason: 'manual', nextAt: null });
    expect((await act('manual', p.id, 'pause')).statusCode).toBe(409);
    minutes(120);
    expect(await t.app.scheduler.runOnce()).toBe(0);
    expect((await act('manual', p.id, 'resume')).json().status).toBe('active');
    const cancelled = await act('manual', p.id, 'cancel');
    expect(cancelled.json()).toMatchObject({ status: 'cancelled', nextAt: null });
    expect(cancelled.json().finishedAt).toBe(clock.toISOString());
    expect((await act('manual', p.id, 'cancel')).statusCode).toBe(409);
    // Cancelling leaves the targeting at the step it reached.
    expect(
      (await flag('manual')).environments.production.fallthrough.rollout.variants[0].weight,
    ).toBe(1_000);
    minutes(120);
    expect(await t.app.scheduler.runOnce()).toBe(0);
    for (const action of ['flag.rollout.pause', 'flag.rollout.resume', 'flag.rollout.cancel']) {
      expect(await audit('manual', action)).toHaveLength(1);
    }
    expect((await act('manual', p.id, 'resume', viewer)).statusCode).toBe(403);
    expect((await act('manual', p.id, 'rewind')).statusCode).toBe(400);
    expect((await act('manual', '00000000-0000-4000-8000-000000000000', 'pause')).statusCode).toBe(
      404,
    );
    expect((await act('ghost', p.id, 'pause')).statusCode).toBe(404);
  });

  it('completes at once when the only step is everyone', async () => {
    await newFlag('all-at-once');
    const done = await start('all-at-once', plan({ steps: [{ weight: ROLLOUT_TOTAL }] }));
    expect(done).toMatchObject({ status: 'completed', nextAt: null, step: 0 });
    expect((await flag('all-at-once')).environments.production.fallthrough).toEqual({
      variant: 'on',
    });
  });

  it('validates the plan, the flag and the environment before starting', async () => {
    await newFlag('checks', false);
    const offFlag = await editor.request('POST', R('checks'), plan());
    expect(offFlag.statusCode).toBe(409);
    expect(offFlag.json().error.message).toContain('turn it on before starting a rollout');

    await editor.request('POST', `${P}/flags/checks/environments/production/kill-switch`, {
      enabled: true,
    });
    const bad = await editor.request('POST', R('checks'), plan({ variant: 'maybe' }));
    expect(bad.json().error.details).toEqual([
      { path: 'variant', message: 'unknown variant "maybe"' },
    ]);
    const shape = await editor.request('POST', R('checks'), plan({ steps: [{ weight: 50 }] }));
    expect(shape.statusCode).toBe(400);
    expect(shape.json().error.details[0].path).toBe('steps.0.weight');
    expect((await viewer.request('POST', R('checks'), plan())).statusCode).toBe(403);
    expect((await editor.request('POST', R('ghost'), plan())).statusCode).toBe(404);
    expect((await viewer.request('GET', R('ghost'))).statusCode).toBe(404);

    await start('checks');
    const second = await editor.request('POST', R('checks'), plan());
    expect(second.statusCode).toBe(409);
    expect(second.json().error.message).toContain('already has a rollout');

    // Another environment has its own plan.
    await editor.request('POST', `${P}/flags/checks/environments/development/kill-switch`, {
      enabled: true,
    });
    const dev = await editor.request('POST', R('checks', 'development'), plan());
    expect(dev.statusCode, dev.body).toBe(201);
  });

  it('cancels live plans when the flag is archived', async () => {
    await newFlag('archived');
    await start('archived');
    const archived = await editor.request('POST', `${P}/flags/archived/archive`, {
      version: (await flag('archived')).version,
    });
    expect(archived.statusCode, archived.body).toBe(200);
    expect((await plans('archived'))[0]).toMatchObject({
      status: 'cancelled',
      error: 'flag was archived',
    });
    minutes(60);
    expect(await t.app.scheduler.runOnce()).toBe(0);
  });

  it('cancels instead of stepping when the scheduler finds the flag archived', async () => {
    await newFlag('archived-late');
    const p = await start('archived-late');
    await t.db
      .updateTable('flags')
      .set({ archived_at: clock })
      .where('id', '=', (await flagId('archived-late')).id)
      .execute();
    minutes(60);
    expect(await t.app.scheduler.runOnce()).toBe(1);
    const rows = await t.db
      .selectFrom('rollout_plans')
      .select(['status', 'error'])
      .where('id', '=', p.id)
      .execute();
    expect(rows).toEqual([{ status: 'cancelled', error: 'flag was archived' }]);
  });

  it('marks a stored plan that no longer parses as failed instead of retrying it', async () => {
    await newFlag('garbled');
    const p = await start('garbled');
    await t.db
      .updateTable('rollout_plans')
      .set({ plan: JSON.stringify({ steps: 'many' }) })
      .where('id', '=', p.id)
      .execute();
    minutes(60);
    expect(await t.app.scheduler.runOnce()).toBe(1);
    expect(await t.app.scheduler.runOnce()).toBe(0);
    const row = await t.db
      .selectFrom('rollout_plans')
      .select(['status', 'error'])
      .where('id', '=', p.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: 'failed', error: 'stored plan is not a valid rollout plan' });
  });

  it('is refused in protected environments, and needs the reason the environment asks for', async () => {
    await newFlag('noted');
    const notes = await admin.request('PUT', `${P}/environments/production/change-notes`, {
      requireReason: true,
      requireLink: false,
    });
    expect(notes.statusCode, notes.body).toBe(200);
    const bare = await editor.request('POST', R('noted'), plan());
    expect(bare.statusCode).toBe(400);
    expect(bare.json().error.details).toEqual([
      { path: 'header.flagship-reason', message: 'required in production' },
    ]);
    const withReason = await editor.request('POST', R('noted'), plan(), {
      headers: { 'flagship-reason': 'ramp the new checkout' },
    });
    expect(withReason.statusCode, withReason.body).toBe(201);
    expect((await audit('noted', 'flag.rollout.start'))[0].reason).toBe('ramp the new checkout');

    const protect = await admin.request('PUT', `${P}/environments/production/approvals`, {
      requiredApprovals: 1,
    });
    expect(protect.statusCode, protect.body).toBe(200);
    await newFlag('guarded', false);
    const refused = await editor.request('POST', R('guarded'), plan(), {
      headers: { 'flagship-reason': 'try' },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.message).toContain('rollout plans go through');
    // A plan already running can still be paused and cancelled there.
    const running = (await plans('noted'))[0];
    expect((await act('noted', running.id, 'pause')).statusCode).toBe(200);
    expect((await act('noted', running.id, 'resume')).statusCode).toBe(403);
    expect((await act('noted', running.id, 'cancel')).statusCode).toBe(200);
  });
});

async function flagId(key: string) {
  return t.db.selectFrom('flags').select('id').where('key', '=', key).executeTakeFirstOrThrow();
}
