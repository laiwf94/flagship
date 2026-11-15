import { evaluate, ROLLOUT_TOTAL, stepServe, type RolloutPlan, type Ruleset } from '@flagship/core';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../app.js';
import { createDatabase, type Db } from '../db/database.js';
import { createLogger } from '../log.js';
import { testApp, type TestApp } from '../../test/app.js';
import { PASSWORD, signIn, userWithRole, type Client } from '../../test/session.js';

/**
 * Rollout plans under random schedules: random step lists, random ticks
 * spread over three instances that race for each due step, and the kill
 * switch thrown and the plan resumed at random points. A model of the plan
 * says which step should be live after every move; the test checks it
 * against the stored plan, the live targeting, the audit trail and what
 * contexts are served.
 */

let t: TestApp;
let editor: Client;
let viewer: Client;
const others: { app: App; db: Db }[] = [];
let instances: App[] = [];
let clock = new Date('2031-01-05T09:00:00Z');
let flags = 0;

const P = '/api/projects/default';
const MIN = 60_000;
const contexts = Array.from({ length: 300 }, (_, i) => ({
  key: `user-${i}`,
  org: `org-${i % 60}`,
}));

type Op = { kind: 'tick'; minutes: number; on: number[] } | { kind: 'kill' } | { kind: 'resume' };

const stepsArb = fc
  .uniqueArray(fc.integer({ min: 1, max: ROLLOUT_TOTAL - 1 }), { minLength: 1, maxLength: 4 })
  .chain((weights) =>
    fc
      .array(fc.integer({ min: 1, max: 120 }), {
        minLength: weights.length,
        maxLength: weights.length,
      })
      .map((holds): { weight: number; holdMinutes?: number }[] => [
        ...[...weights]
          .sort((a, b) => a - b)
          .map((weight, i) => ({ weight, holdMinutes: holds[i] ?? 1 })),
        { weight: ROLLOUT_TOTAL },
      ]),
  );

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      kind: fc.constant('tick' as const),
      minutes: fc.integer({ min: 1, max: 150 }),
      on: fc.subarray([0, 1, 2], { minLength: 1 }),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ kind: 'kill' as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'resume' as const }) },
);

const R = (flag: string) => `${P}/flags/${flag}/environments/production/rollout-plans`;

async function killSwitch(flag: string, enabled: boolean) {
  const res = await editor.request(
    'POST',
    `${P}/flags/${flag}/environments/production/kill-switch`,
    { enabled },
  );
  expect(res.statusCode, res.body).toBe(200);
}

async function live(flag: string) {
  return (await viewer.request('GET', `${P}/flags/${flag}`)).json().environments.production;
}

async function storedPlan(flag: string) {
  return (await viewer.request('GET', R(flag))).json().plans[0];
}

async function onSet(flag: string): Promise<Set<string>> {
  const rs: Ruleset = (await viewer.request('GET', `${P}/environments/production/ruleset`)).json();
  const on = new Set<string>();
  for (const c of contexts) {
    const e = evaluate(rs, flag, c);
    if ('variant' in e && e.variant === 'on') on.add(c.key);
  }
  return on;
}

/** Step audit entries, oldest first. */
async function stepAudit(flag: string) {
  const entries = (
    await viewer.request('GET', `${P}/audit?flag=${flag}&action=flag.rollout.step&limit=200`)
  ).json().entries as { action: string; after: { fallthrough: unknown } }[];
  return entries.filter((e) => e.action === 'flag.rollout.step').reverse();
}

beforeAll(async () => {
  t = await testApp(
    {
      bootstrapAdmin: { email: 'root@example.com', password: PASSWORD },
      schedulerIntervalMs: 3_600_000,
      sessionIdleMinutes: 10_000_000,
      sessionMaxHours: 10_000_000,
    },
    { now: () => clock },
  );
  await signIn(t.app.server, 'root@example.com');
  editor = await userWithRole(t.app.server, t.db, 'eddie@example.com', 'editor');
  viewer = await userWithRole(t.app.server, t.db, 'vera@example.com', 'viewer');
  for (let i = 0; i < 2; i++) {
    const { db } = createDatabase({ url: t.url, maxConnections: 5 });
    const app = await buildApp({
      config: t.config,
      db,
      logger: createLogger('silent'),
      now: () => clock,
    });
    others.push({ app, db });
  }
  instances = [t.app, ...others.map((o) => o.app)];
});
afterAll(async () => {
  for (const o of others) {
    await o.app.close();
    await o.db.destroy();
  }
  await t.close();
});

describe('rollout plans under random schedules (property)', () => {
  it('step once per step across instances, pause on the kill switch and keep stickiness', async () => {
    await fc.assert(
      fc.asyncProperty(
        stepsArb,
        fc.constantFrom<'key' | 'org'>('key', 'org'),
        fc.array(opArb, { minLength: 3, maxLength: 12 }),
        async (steps, bucketBy, ops) => {
          const flag = `prop-${++flags}`;
          const created = await editor.request('POST', `${P}/flags`, {
            key: flag,
            name: flag,
            type: 'boolean',
          });
          expect(created.statusCode, created.body).toBe(201);
          await killSwitch(flag, true);
          const plan: RolloutPlan = {
            target: 'fallthrough',
            variant: 'on',
            baseline: 'off',
            steps,
            ...(bucketBy === 'org' ? { bucketBy: 'org' } : {}),
          };
          const started = await editor.request('POST', R(flag), plan);
          expect(started.statusCode, started.body).toBe(201);
          const id: string = started.json().id;
          const last = steps.length - 1;

          // The model: which step is live, whether it is waiting, and when the next is due.
          let step = 0;
          let status: 'active' | 'paused' | 'completed' = last === 0 ? 'completed' : 'active';
          let enabled = true;
          let due: number | null =
            status === 'active' ? clock.getTime() + (steps[0]?.holdMinutes ?? 0) * MIN : null;
          let had = await onSet(flag);

          const check = async () => {
            const stored = await storedPlan(flag);
            expect(stored).toMatchObject({ id, status, step });
            expect(stored.nextAt).toBe(due === null ? null : new Date(due).toISOString());
            const config = await live(flag);
            expect(config.enabled).toBe(enabled);
            expect(config.fallthrough).toEqual(stepServe(plan, step));
            if (!enabled) return;
            const on = await onSet(flag);
            for (const key of had) expect(on.has(key), `${key} left the variant`).toBe(true);
            if (bucketBy === 'org') {
              for (const c of contexts) {
                expect(on.has(c.key)).toBe(on.has(`user-${Number(c.org.slice(4))}`));
              }
            }
            had = on;
          };

          const tick = async (minutes: number, on: number[]) => {
            clock = new Date(clock.getTime() + minutes * MIN);
            const applied = await Promise.all(on.map((i) => instances[i]!.scheduler.runOnce()));
            const expected = status === 'active' && due !== null && clock.getTime() >= due ? 1 : 0;
            expect(applied.reduce((a, b) => a + b, 0)).toBe(expected);
            if (expected === 1) {
              step++;
              if (step === last) {
                status = 'completed';
                due = null;
              } else {
                due = clock.getTime() + (steps[step]?.holdMinutes ?? 0) * MIN;
              }
            }
          };

          const resume = async () => {
            if (!enabled) {
              await killSwitch(flag, true);
              enabled = true;
            }
            // Turning the flag back on leaves the plan paused until someone resumes it.
            await check();
            if (status !== 'paused') return;
            const res = await editor.request('POST', `${R(flag)}/${id}/resume`, {});
            expect(res.statusCode, res.body).toBe(200);
            status = 'active';
            due = clock.getTime() + (steps[step]?.holdMinutes ?? 0) * MIN;
          };

          await check();
          for (const op of ops) {
            if (op.kind === 'tick') {
              await tick(op.minutes, op.on);
            } else if (op.kind === 'kill') {
              if (!enabled) continue;
              await killSwitch(flag, false);
              enabled = false;
              if (status === 'active') {
                status = 'paused';
                due = null;
              }
            } else {
              await resume();
            }
            await check();
          }

          // Finish the plan from wherever the schedule left it.
          await resume();
          while (status !== 'completed') {
            await tick(121, [0, 1, 2]);
            await check();
          }
          await tick(600, [0, 1, 2]);
          await check();
          expect(had.size).toBe(contexts.length);

          // One audit entry per step, in order, each with that step's serve.
          const audit = await stepAudit(flag);
          expect(audit.map((e) => e.after.fallthrough)).toEqual(
            steps.map((_, i) => stepServe(plan, i)),
          );
        },
      ),
      { numRuns: 12, seed: 20261115 },
    );
  }, 240_000);
});
