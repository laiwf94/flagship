import { ROLLOUT_TOTAL } from '@flagship/core';
import { studentTQuantile, wilsonInterval } from '@flagship/stats';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { RolledUpVariant } from './experimentRollup.js';
import { allocationIssue, analyze, type AnalysisInput, type Metric } from './experiments.js';

const rolled = (variant: string, exposed: number, p: Partial<RolledUpVariant> = {}) => ({
  variant,
  exposed,
  converted: 0,
  conversions: 0,
  value: 0,
  valueSquares: 0,
  conversionSquares: 0,
  ...p,
});

function input(
  exposed: Record<string, number>,
  rows: RolledUpVariant[],
  patch: Partial<AnalysisInput> = {},
): AnalysisInput {
  const metrics: Metric[] = patch.metrics
    ? [...patch.metrics]
    : [{ event: 'buy', kind: 'conversion' }];
  return {
    control: 'off',
    allocation: {
      variants: [
        { variant: 'on', weight: ROLLOUT_TOTAL / 2 },
        { variant: 'off', weight: ROLLOUT_TOTAL / 2 },
      ],
    },
    metrics,
    exposed: new Map(Object.entries(exposed)),
    conversions: new Map(metrics.map((m) => [m.event, rows])),
    ...patch,
  };
}

describe('analyze', () => {
  it('puts the control first, then the allocation order, then unexpected variants', () => {
    const r = analyze(
      input({ off: 10, b: 10, a: 1, on: 10 }, [], {
        allocation: {
          variants: [
            { variant: 'on', weight: 30_000 },
            { variant: 'b', weight: 40_000 },
            { variant: 'off', weight: 30_000 },
          ],
        },
        showMismatched: true,
      }),
    );
    expect(r.variants.map((v) => [v.variant, v.weight])).toEqual([
      ['off', 30_000],
      ['on', 30_000],
      ['b', 40_000],
      ['a', 0],
    ]);
    expect(r.exposed).toBe(31);
    expect(r.srm.mismatch).toBe(true);
    expect(r.metrics?.[0]?.variants.map((v) => v.variant)).toEqual(['off', 'on', 'b', 'a']);
  });

  it('adds up weights given twice for one variant', () => {
    const r = analyze(
      input({ off: 50, on: 50 }, [], {
        allocation: {
          variants: [
            { variant: 'on', weight: 25_000 },
            { variant: 'off', weight: 50_000 },
            { variant: 'on', weight: 25_000 },
          ],
        },
      }),
    );
    expect(r.variants).toEqual([
      { variant: 'off', weight: 50_000, exposed: 50, expected: 50 },
      { variant: 'on', weight: 50_000, exposed: 50, expected: 50 },
    ]);
    expect(r.srm.pValue).toBe(1);
  });

  it('gives no mean, interval or comparison where there is nothing to estimate', () => {
    const r = analyze(
      input(
        { off: 1 },
        [rolled('off', 1, { converted: 1, conversions: 3, conversionSquares: 9 })],
        {
          metrics: [
            { event: 'buy', kind: 'conversion' },
            { event: 'buy', kind: 'count' },
          ],
        },
      ),
    );
    // One control context and no treatment exposures: no SRM can be told apart from chance.
    expect(r.srm.mismatch).toBe(false);
    const [rate, count] = r.metrics ?? [];
    expect(rate?.variants[0]).toMatchObject({ mean: 1, interval: wilsonInterval(1, 1) });
    expect(rate?.variants[1]).toMatchObject({
      exposed: 0,
      mean: null,
      interval: null,
      comparison: null,
    });
    expect(count?.variants[0]).toMatchObject({ mean: 3, interval: null, comparison: null });
  });

  it('uses t intervals for counts and values, and no lift on a zero control', () => {
    const rows = [
      rolled('off', 4),
      rolled('on', 4, {
        converted: 2,
        conversions: 3,
        conversionSquares: 5,
        value: 6,
        valueSquares: 20,
      }),
    ];
    const r = analyze(
      input({ off: 4, on: 4 }, rows, {
        metrics: [
          { event: 'buy', kind: 'count' },
          { event: 'buy', kind: 'value' },
        ],
      }),
    );
    const [count, value] = r.metrics ?? [];
    // Counts 2, 1, 0, 0: mean 0.75, variance (5 − 3·0.75)/3.
    const sd = Math.sqrt((5 - 3 * 0.75) / 3);
    const t = studentTQuantile(0.975, 3);
    const on = count?.variants[1];
    expect(on?.mean).toBe(0.75);
    expect(on?.interval?.lower).toBeCloseTo(0.75 - (t * sd) / 2, 12);
    expect(on?.interval?.upper).toBeCloseTo(0.75 + (t * sd) / 2, 12);
    expect(on?.comparison).toMatchObject({ difference: 0.75, lift: null, liftInterval: null });
    expect(value?.variants[1]?.mean).toBe(1.5);
    expect(value?.variants[0]?.interval).toEqual({ lower: 0, upper: 0 });
  });

  it('hides metrics on a mismatch unless asked, and never hides an exactly proportional split', () => {
    const skewed = input({ off: 1000, on: 1300 }, []);
    expect(analyze(skewed)).toMatchObject({
      metrics: null,
      warning: { code: 'sample_ratio_mismatch' },
    });
    expect(analyze({ ...skewed, showMismatched: true })).toMatchObject({ warning: null });
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 99 }),
        fc.integer({ min: 1, max: 1000 }),
        (share, scale) => {
          const r = analyze(
            input({ off: share * scale, on: (100 - share) * scale }, [], {
              allocation: {
                variants: [
                  { variant: 'off', weight: share * 1000 },
                  { variant: 'on', weight: (100 - share) * 1000 },
                ],
              },
            }),
          );
          return r.warning === null && r.srm.statistic < 1e-9;
        },
      ),
    );
  });
});

describe('allocationIssue', () => {
  const rollout = (on: number) => ({
    rollout: {
      variants: [
        { variant: 'on', weight: on },
        { variant: 'off', weight: ROLLOUT_TOTAL - on },
      ],
    },
  });
  it('accepts a split that serves the control and another variant', () => {
    expect(allocationIssue(rollout(1), 'off')).toBeUndefined();
    expect(allocationIssue(rollout(1), 'on')).toBeUndefined();
  });
  it('names what is missing', () => {
    expect(allocationIssue(undefined, 'off')).toMatch(/rule does not exist/);
    expect(allocationIssue({ variant: 'on' }, 'off')).toMatch(/not a percentage rollout/);
    expect(allocationIssue(rollout(0), 'on')).toMatch(/"on" gets no traffic/);
    expect(allocationIssue(rollout(0), 'off')).toMatch(/only one variant/);
  });
});
