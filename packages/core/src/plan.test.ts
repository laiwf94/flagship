import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { evaluate } from './evaluate.js';
import { ROLLOUT_TOTAL, rolloutPlanSchema, type Flag, type RolloutPlan } from './model.js';
import {
  DEFAULT_ROLLOUT_STEPS,
  rolloutPlanIssues,
  sameServe,
  serveAt,
  stepServe,
  withServeAt,
} from './plan.js';

const flag = (patch: Partial<Flag> = {}): Flag => ({
  key: 'checkout',
  type: 'boolean',
  variants: [
    { key: 'on', value: true },
    { key: 'off', value: false },
  ],
  enabled: true,
  offVariant: 'off',
  prerequisites: [],
  rules: [
    {
      id: 'staff',
      clauses: [{ attribute: 'email', operator: 'endsWith', values: ['@example.com'] }],
      serve: { variant: 'on' },
    },
  ],
  fallthrough: { variant: 'off' },
  salt: 'checkout',
  clientSide: false,
  version: 1,
  ...patch,
});

function variantFor(f: Flag, key: string): string | undefined {
  const rs = { environment: 'production', version: 1, flags: { [f.key]: f }, segments: {} };
  const e = evaluate(rs, f.key, { key });
  return 'variant' in e ? e.variant : undefined;
}

const plan = (patch: Partial<RolloutPlan> = {}): RolloutPlan => ({
  target: 'fallthrough',
  variant: 'on',
  baseline: 'off',
  steps: [...DEFAULT_ROLLOUT_STEPS],
  ...patch,
});

function issuesOf(input: unknown): string[] {
  const r = rolloutPlanSchema.safeParse(input);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

describe('rolloutPlanSchema', () => {
  it('accepts the default plan and a single 100% step', () => {
    expect(issuesOf(plan())).toEqual([]);
    expect(issuesOf(plan({ steps: [{ weight: ROLLOUT_TOTAL }] }))).toEqual([]);
    expect(issuesOf(plan({ target: { rule: 'staff' }, bucketBy: 'org' }))).toEqual([]);
  });

  it('rejects steps that do not grow, a missing hold, a short last step and one variant', () => {
    expect(
      issuesOf(
        plan({
          variant: 'on',
          baseline: 'on',
          steps: [
            { weight: 5_000, holdMinutes: 10 },
            { weight: 5_000, holdMinutes: 10 },
            { weight: 20_000 },
            { weight: 90_000 },
          ],
        }),
      ),
    ).toEqual([
      'baseline: must differ from the rolled-out variant',
      'steps.1.weight: must be larger than the step before',
      'steps.2.holdMinutes: is required on every step but the last',
      'steps.3.weight: the last step must be 100000 (100%)',
    ]);
    expect(issuesOf(plan({ steps: [] }))).toHaveLength(2);
    expect(issuesOf(plan({ steps: [{ weight: 0 }] })).length).toBeGreaterThan(0);
    expect(
      issuesOf(plan({ steps: [{ weight: 1, holdMinutes: 0 }, { weight: ROLLOUT_TOTAL }] })).length,
    ).toBeGreaterThan(0);
    expect(issuesOf({ ...plan(), extra: true }).length).toBeGreaterThan(0);
  });
});

describe('stepServe', () => {
  it('splits rolled-out first, then serves the variant outright on the last step', () => {
    const p = plan({ bucketBy: 'org' });
    expect(stepServe(p, 0)).toEqual({
      rollout: {
        bucketBy: 'org',
        variants: [
          { variant: 'on', weight: 1_000 },
          { variant: 'off', weight: 99_000 },
        ],
      },
    });
    expect(stepServe(p, p.steps.length - 1)).toEqual({ variant: 'on' });
    expect(() => stepServe(p, p.steps.length)).toThrow(RangeError);
  });

  it('keeps everyone who had the variant at one step on it at every later step (property)', () => {
    const steps = fc
      .uniqueArray(fc.integer({ min: 1, max: ROLLOUT_TOTAL - 1 }), { maxLength: 8 })
      .map((ws) => [
        ...ws.sort((a, b) => a - b).map((weight) => ({ weight, holdMinutes: 1 })),
        { weight: ROLLOUT_TOTAL },
      ]);
    fc.assert(
      fc.property(
        steps,
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 12 }), { minLength: 1, maxLength: 50 }),
        fc.string({ minLength: 1, maxLength: 10 }),
        (stepList, keys, salt) => {
          const p = plan({ steps: stepList });
          expect(rolloutPlanSchema.safeParse(p).success).toBe(true);
          let had = new Set<string>();
          for (let i = 0; i < p.steps.length; i++) {
            const f = flag({ salt, fallthrough: stepServe(p, i), rules: [] });
            const now = new Set(keys.filter((key) => variantFor(f, key) === 'on'));
            for (const key of had) expect(now.has(key)).toBe(true);
            had = now;
          }
          expect(had.size).toBe(keys.length);
        },
      ),
    );
  });

  it('serves close to each step’s share over many contexts', () => {
    const p = plan();
    const keys = Array.from({ length: 20_000 }, (_, i) => `user-${i}`);
    for (let i = 0; i < p.steps.length - 1; i++) {
      const f = flag({ fallthrough: stepServe(p, i), rules: [] });
      const on = keys.filter((key) => variantFor(f, key) === 'on').length;
      const share = (p.steps[i]?.weight ?? 0) / ROLLOUT_TOTAL;
      expect(Math.abs(on / keys.length - share)).toBeLessThan(0.01);
    }
  });
});

describe('targets', () => {
  it('reads and writes the default rule or one rule by id', () => {
    const f = flag();
    const serve = stepServe(plan(), 0);
    expect(serveAt(f, 'fallthrough')).toEqual({ variant: 'off' });
    expect(serveAt(f, { rule: 'staff' })).toEqual({ variant: 'on' });
    expect(serveAt(f, { rule: 'ghost' })).toBeUndefined();
    expect(withServeAt(f, 'fallthrough', serve)).toEqual({ rules: f.rules, fallthrough: serve });
    const ruled = withServeAt(f, { rule: 'staff' }, serve);
    expect(ruled?.rules[0]).toEqual({ ...f.rules[0], serve });
    expect(ruled?.fallthrough).toEqual(f.fallthrough);
    expect(f.rules[0]?.serve).toEqual({ variant: 'on' });
    expect(withServeAt(f, { rule: 'ghost' }, serve)).toBeUndefined();
  });

  it('reports unknown variants and rules', () => {
    expect(rolloutPlanIssues(plan(), flag())).toEqual([]);
    expect(
      rolloutPlanIssues(
        plan({ variant: 'maybe', baseline: 'nope', target: { rule: 'x' } }),
        flag(),
      ),
    ).toEqual([
      { path: 'variant', message: 'unknown variant "maybe"' },
      { path: 'baseline', message: 'unknown variant "nope"' },
      { path: 'target.rule', message: 'unknown rule "x"' },
    ]);
  });
});

describe('sameServe', () => {
  it('compares variants, bucketBy (key by default) and weights in order', () => {
    const split = stepServe(plan(), 1);
    expect(sameServe(split, stepServe(plan(), 1))).toBe(true);
    expect(sameServe(split, stepServe(plan({ bucketBy: 'key' }), 1))).toBe(true);
    expect(sameServe(split, stepServe(plan({ bucketBy: 'org' }), 1))).toBe(false);
    expect(sameServe(split, stepServe(plan(), 2))).toBe(false);
    expect(sameServe(split, { variant: 'on' })).toBe(false);
    expect(sameServe({ variant: 'on' }, { variant: 'on' })).toBe(true);
    expect(sameServe({ variant: 'on' }, { variant: 'off' })).toBe(false);
    if (!('rollout' in split)) throw new Error('expected a split');
    const reversed = { rollout: { variants: [...split.rollout.variants].reverse() } };
    expect(sameServe(split, reversed)).toBe(false);
    expect(sameServe(split, { rollout: { variants: split.rollout.variants.slice(0, 1) } })).toBe(
      false,
    );
  });
});
