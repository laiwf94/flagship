import { ROLLOUT_TOTAL } from '@flagship/core';
import { describe, expect, it } from 'vitest';
import { defaultDraft, holdLabel, planFromDraft, type PlanDraft } from './RolloutPlan';

const flag = {
  type: 'boolean' as const,
  variants: [
    { key: 'off', value: false },
    { key: 'on', value: true },
  ],
};

const draft = (patch: Partial<PlanDraft> = {}): PlanDraft => ({ ...defaultDraft(flag), ...patch });

describe('defaultDraft', () => {
  it('rolls the true variant out over the false one in the default steps', () => {
    expect(defaultDraft(flag)).toEqual({
      target: 'fallthrough',
      variant: 'on',
      baseline: 'off',
      bucketBy: '',
      steps: [
        { percent: '1', hold: '60' },
        { percent: '5', hold: '60' },
        { percent: '10', hold: '60' },
        { percent: '25', hold: '60' },
        { percent: '50', hold: '60' },
      ],
    });
  });

  it('rolls the second variant out over the first for other types', () => {
    const d = defaultDraft({
      type: 'string',
      variants: [
        { key: 'control', value: 'a' },
        { key: 'treatment', value: 'b' },
      ],
    });
    expect([d.variant, d.baseline]).toEqual(['treatment', 'control']);
  });
});

describe('planFromDraft', () => {
  it('builds a plan that ends at everyone', () => {
    const r = planFromDraft(
      draft({
        target: 'beta',
        bucketBy: ' org ',
        steps: [
          { percent: '0.5', hold: '30' },
          { percent: '20', hold: '1440' },
        ],
      }),
    );
    expect(r).toEqual({
      ok: true,
      plan: {
        target: { rule: 'beta' },
        variant: 'on',
        baseline: 'off',
        bucketBy: 'org',
        steps: [
          { weight: 500, holdMinutes: 30 },
          { weight: 20_000, holdMinutes: 1440 },
          { weight: ROLLOUT_TOTAL },
        ],
      },
    });
    expect(planFromDraft(draft({ steps: [] }))).toEqual({
      ok: true,
      plan: {
        target: 'fallthrough',
        variant: 'on',
        baseline: 'off',
        steps: [{ weight: ROLLOUT_TOTAL }],
      },
    });
  });

  it('reports each problem against its field', () => {
    const r = planFromDraft(
      draft({
        baseline: 'on',
        bucketBy: 'not an attribute',
        steps: [
          { percent: '', hold: '60' },
          { percent: '100', hold: '60' },
          { percent: '10.0005', hold: '60' },
          { percent: '10', hold: '60' },
          { percent: '5', hold: '60' },
          { percent: '50', hold: '0' },
          { percent: '60', hold: '1.5' },
        ],
      }),
    );
    expect(r).toEqual({
      ok: false,
      errors: {
        baseline: 'Pick a different variant',
        bucketBy: 'Use an attribute name such as "org"',
        step0: 'Enter a percentage above 0 and below 100',
        step1: 'Enter a percentage above 0 and below 100',
        step2: 'Use at most three decimals',
        step4: 'Each step must be larger than the one before',
        step5: 'Hold for 1 minute to 30 days',
        step6: 'Hold for 1 minute to 30 days',
      },
    });
  });
});

describe('holdLabel', () => {
  it('uses the largest whole unit', () => {
    expect(holdLabel(45)).toBe('45 min');
    expect(holdLabel(90)).toBe('90 min');
    expect(holdLabel(120)).toBe('2 h');
    expect(holdLabel(2880)).toBe('2 d');
  });
});
