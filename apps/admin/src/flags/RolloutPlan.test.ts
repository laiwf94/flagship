import { ROLLOUT_TOTAL } from '@flagship/core';
import { describe, expect, it } from 'vitest';
import type { GuardReading } from '../api';
import {
  defaultDraft,
  guardLabel,
  holdLabel,
  NEW_GUARD,
  planFromDraft,
  readingLabel,
  type PlanDraft,
} from './RolloutPlan';

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
      guards: [],
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

describe('guards in the draft', () => {
  it('turns tolerances in percent into fractions and keeps the rest', () => {
    const r = planFromDraft(
      draft({
        steps: [],
        guards: [
          { ...NEW_GUARD, event: ' error ' },
          {
            event: 'checkout',
            kind: 'value',
            worse: 'lower',
            threshold: '12.5',
            minContexts: '500',
            action: 'rollback',
          },
        ],
      }),
    );
    expect(r).toEqual({
      ok: true,
      plan: {
        target: 'fallthrough',
        variant: 'on',
        baseline: 'off',
        steps: [{ weight: ROLLOUT_TOTAL }],
        guards: [
          {
            event: 'error',
            kind: 'conversion',
            worse: 'higher',
            threshold: 0,
            minContexts: 100,
            action: 'pause',
          },
          {
            event: 'checkout',
            kind: 'value',
            worse: 'lower',
            threshold: 0.125,
            minContexts: 500,
            action: 'rollback',
          },
        ],
      },
    });
  });

  it('reports each bad guard against its row', () => {
    const r = planFromDraft(
      draft({
        guards: [
          { ...NEW_GUARD, event: '' },
          { ...NEW_GUARD, event: 'error' },
          { ...NEW_GUARD, event: 'error' },
          { ...NEW_GUARD, event: 'latency', threshold: '-1' },
          { ...NEW_GUARD, event: 'latency', kind: 'count', minContexts: '9' },
          { ...NEW_GUARD, event: 'cpu', minContexts: '10.5' },
        ],
      }),
    );
    expect(r).toEqual({
      ok: false,
      errors: {
        guard0: 'Enter the event key the SDK tracks, such as "error"',
        guard2: 'This metric is already guarded',
        guard3: 'Tolerate 0% to 1000%',
        guard4: 'Wait for 10 to 1,000,000 contexts',
        guard5: 'Wait for 10 to 1,000,000 contexts',
      },
    });
  });

  it('describes a guard and a reading in plain words', () => {
    const g = {
      event: 'error',
      kind: 'conversion',
      worse: 'higher',
      threshold: 0.1,
      minContexts: 1000,
      action: 'rollback',
    } as const;
    expect(guardLabel(g, 'off')).toBe(
      'Rolls back if share of contexts sending "error" is higher than on off by more than 10%, once 1,000 contexts have seen each variant.',
    );
    expect(guardLabel({ ...g, kind: 'value', threshold: 0, action: 'pause' }, 'off')).toBe(
      'Pauses if value per context of "error" is higher than on off, once 1,000 contexts have seen each variant.',
    );
    const reading: GuardReading = {
      guard: g,
      state: 'breached',
      variant: { variant: 'on', exposed: 1200, mean: 0.2 },
      baseline: { variant: 'off', exposed: 12_000, mean: 0.05 },
      lift: 3,
      liftInterval: { lower: 2.25, upper: 3.754 },
      difference: 0.15,
      differenceInterval: { lower: 0.1, upper: 0.2 },
      pValue: 0,
    };
    expect(readingLabel(reading)).toBe(
      '20% on on (1,200 contexts) against 5% on off (12,000): +300%, interval +225% to +375.4%.',
    );
    expect(
      readingLabel({
        ...reading,
        guard: { ...g, kind: 'count' },
        variant: { variant: 'on', exposed: 10, mean: 1.23456 },
        baseline: { variant: 'off', exposed: 0, mean: null },
        lift: null,
        liftInterval: null,
      }),
    ).toBe('1.23 on on (10 contexts) against no data on off (0).');
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
