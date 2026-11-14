import { describe, expect, it } from 'vitest';
import { expectClose, seeded } from '../test/close.js';
import { normalQuantile } from './distributions.js';
import {
  ratioOfMeans,
  relativeLift,
  sampleRatioMismatch,
  summarize,
  welchTTest,
  wilsonInterval,
  type Summary,
} from './inference.js';

// Reference results are from SciPy 1.17: scipy.stats.ttest_ind(equal_var=False)
// and its confidence_interval(), scipy.stats.chisquare, and the Wilson formula
// with scipy.stats.norm.ppf(0.975).

function summaryOf(values: readonly number[]): Summary {
  let sum = 0;
  let squares = 0;
  for (const v of values) {
    sum += v;
    squares += v * v;
  }
  return summarize(values.length, sum, squares);
}

describe('summarize', () => {
  it('gives the mean and the n − 1 sample variance', () => {
    const s = summaryOf([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(s.n).toBe(8);
    expect(s.mean).toBe(5);
    expectClose(s.variance, 32 / 7, 1e-15);
  });

  it('reads a 0/1 metric from its count, as the rollup stores it', () => {
    // 81 of 263 converted: sum = sum of squares = 81.
    const s = summarize(263, 81, 81);
    const p = 81 / 263;
    expectClose(s.mean, p, 1e-15);
    expectClose(s.variance, (p * (1 - p) * 263) / 262, 1e-13);
  });

  it('handles empty, single and constant samples', () => {
    expect(summarize(0, 0, 0)).toEqual({ n: 0, mean: 0, variance: 0 });
    expect(summarize(1, 3, 9)).toEqual({ n: 1, mean: 3, variance: 0 });
    // 0.1 × 3 does not cancel exactly; the variance must not go negative.
    expect(summarize(3, 0.1 + 0.1 + 0.1, 0.01 + 0.01 + 0.01).variance).toBeGreaterThanOrEqual(0);
  });

  it('refuses bad input', () => {
    expect(() => summarize(-1, 0, 0)).toThrow(RangeError);
    expect(() => summarize(1.5, 0, 0)).toThrow(RangeError);
    expect(() => summarize(2, NaN, 0)).toThrow(RangeError);
    expect(() => summarize(2, 1, Infinity)).toThrow(RangeError);
  });
});

describe("Welch's t-test", () => {
  it('matches SciPy on raw samples, including the interval', () => {
    const control = summaryOf([19.1, 20.3, 18.7, 22.4, 21.0, 19.9]);
    const treatment = summaryOf([23.2, 21.8, 25.1, 22.9, 24.4, 23.7, 26.0]);
    const r = welchTTest(control, treatment);
    expect(r).not.toBeNull();
    expectClose(r!.t, 4.745890918435177, 1e-12);
    expectClose(r!.df, 10.853446575095688, 1e-12);
    expectClose(r!.pValue, 0.0006263807185119477, 1e-10);
    expectClose(r!.interval.lower, 1.94808481321786, 1e-11);
    expectClose(r!.interval.upper, 5.328105662972612, 1e-11);
  });

  it('matches SciPy from summary statistics', () => {
    const r = welchTTest(
      { n: 30, mean: 10.2, variance: 4.1 },
      { n: 25, mean: 11.6, variance: 9.3 },
    );
    expectClose(r!.difference, 1.4, 1e-14);
    expectClose(r!.standardError, 0.7132087118555597, 1e-14);
    expectClose(r!.df, 40.36494591237674, 1e-13);
    expectClose(r!.t, 1.9629597574006232, 1e-14);
    expectClose(r!.pValue, 0.056567460258951416, 1e-11);
    expectClose(r!.interval.lower, -0.04104272278057941, 1e-10);
    expectClose(r!.interval.upper, 2.84104272278058, 1e-12);
  });

  it('matches SciPy on conversion rates from rollup counts', () => {
    // 100 of 1,000 against 120 of 1,000.
    const r = welchTTest(summarize(1000, 100, 100), summarize(1000, 120, 120));
    expectClose(r!.df, 1985.3714563542524, 1e-12);
    expectClose(r!.t, 1.42931619499538, 1e-12);
    expectClose(r!.pValue, 0.15307069563458256, 1e-11);
    expectClose(r!.interval.lower, -0.0074419275882051696, 1e-10);
    expectClose(r!.interval.upper, 0.047441927588205146, 1e-12);
  });

  it('widens the interval with the confidence level', () => {
    const c = { n: 30, mean: 10.2, variance: 4.1 };
    const t = { n: 25, mean: 11.6, variance: 9.3 };
    const r95 = welchTTest(c, t)!;
    const r99 = welchTTest(c, t, { confidence: 0.99 })!;
    expect(r99.interval.lower).toBeLessThan(r95.interval.lower);
    expect(r99.interval.upper).toBeGreaterThan(r95.interval.upper);
    expect(r99.pValue).toBe(r95.pValue);
  });

  it('is null without two values per side, and exact when nothing varies', () => {
    expect(welchTTest({ n: 1, mean: 1, variance: 0 }, { n: 5, mean: 1, variance: 1 })).toBeNull();
    expect(welchTTest({ n: 5, mean: 1, variance: 1 }, { n: 0, mean: 0, variance: 0 })).toBeNull();
    const same = welchTTest({ n: 4, mean: 2, variance: 0 }, { n: 4, mean: 2, variance: 0 })!;
    expect(same).toMatchObject({ difference: 0, t: 0, pValue: 1, standardError: 0, df: 6 });
    const up = welchTTest({ n: 4, mean: 2, variance: 0 }, { n: 4, mean: 3, variance: 0 })!;
    expect(up).toMatchObject({ t: Infinity, pValue: 0, interval: { lower: 1, upper: 1 } });
    const down = welchTTest({ n: 4, mean: 3, variance: 0 }, { n: 4, mean: 2, variance: 0 })!;
    expect(down.t).toBe(-Infinity);
  });

  it('refuses bad input', () => {
    const ok = { n: 5, mean: 1, variance: 1 };
    expect(() => welchTTest({ n: 5, mean: 1, variance: -1 }, ok)).toThrow(RangeError);
    expect(() => welchTTest(ok, { n: 5, mean: NaN, variance: 1 })).toThrow(RangeError);
    expect(() => welchTTest(ok, { n: -5, mean: 1, variance: 1 })).toThrow(RangeError);
    expect(() => welchTTest(ok, ok, { confidence: 1 })).toThrow(RangeError);
    expect(() => welchTTest(ok, ok, { confidence: 0 })).toThrow(RangeError);
  });

  it('covers the true difference 95% of the time on skewed data', () => {
    // Exponential values (mean 1 vs 1.1), unequal sizes: the case Welch is for.
    const random = seeded(7);
    const draw = (n: number, mean: number): Summary => {
      let sum = 0;
      let squares = 0;
      for (let i = 0; i < n; i++) {
        const v = -mean * Math.log(1 - random());
        sum += v;
        squares += v * v;
      }
      return summarize(n, sum, squares);
    };
    const runs = 2000;
    let covered = 0;
    for (let i = 0; i < runs; i++) {
      const r = welchTTest(draw(400, 1), draw(250, 1.1))!;
      if (r.interval.lower <= 0.1 && 0.1 <= r.interval.upper) covered++;
    }
    // Binomial(2000, 0.95) has a standard deviation of about 0.5%.
    expect(covered / runs).toBeGreaterThan(0.935);
    expect(covered / runs).toBeLessThan(0.965);
  });
});

describe('relative lift (delta method)', () => {
  it('computes lift, standard error and interval', () => {
    const control = summarize(1000, 100, 100);
    const treatment = summarize(1000, 120, 120);
    const r = relativeLift(control, treatment)!;
    expectClose(r.lift, 0.2, 1e-14);
    // Var(T̄)/μc² + μt²·Var(C̄)/μc⁴ with the n − 1 variances.
    const vt = (0.12 * 0.88 * 1000) / 999 / 1000;
    const vc = (0.1 * 0.9 * 1000) / 999 / 1000;
    const se = Math.sqrt(vt / 0.01 + (0.0144 * vc) / 0.0001);
    expectClose(r.standardError, se, 1e-14);
    const z = normalQuantile(0.975);
    expectClose(r.interval.lower, 0.2 - z * se, 1e-13);
    expectClose(r.interval.upper, 0.2 + z * se, 1e-13);
    expect(r.pValue).toBeGreaterThan(0.05);
    expect(r.pValue).toBeLessThan(0.3);
  });

  it('is null when the control mean is 0 or a side is too small', () => {
    expect(relativeLift(summarize(100, 0, 0), summarize(100, 5, 5))).toBeNull();
    expect(relativeLift(summarize(1, 1, 1), summarize(100, 5, 5))).toBeNull();
  });

  it('is exact when nothing varies', () => {
    expect(relativeLift(summarize(4, 8, 16), summarize(4, 8, 16))).toMatchObject({
      lift: 0,
      standardError: 0,
      pValue: 1,
    });
    expect(relativeLift(summarize(4, 8, 16), summarize(4, 12, 36))!.pValue).toBe(0);
  });

  it('covers the true lift 95% of the time on conversion rates', () => {
    const random = seeded(11);
    const draw = (n: number, p: number): Summary => {
      let k = 0;
      for (let i = 0; i < n; i++) if (random() < p) k++;
      return summarize(n, k, k);
    };
    const runs = 2000;
    let covered = 0;
    for (let i = 0; i < runs; i++) {
      const r = relativeLift(draw(3000, 0.1), draw(3000, 0.12))!;
      if (r.interval.lower <= 0.2 && 0.2 <= r.interval.upper) covered++;
    }
    expect(covered / runs).toBeGreaterThan(0.935);
    expect(covered / runs).toBeLessThan(0.965);
  });
});

describe('ratio of means (delta method)', () => {
  it('uses the covariance between numerator and denominator', () => {
    const base = { n: 500, meanX: 30, meanY: 2, varianceX: 400, varianceY: 1.5 };
    const independent = ratioOfMeans({ ...base, covariance: 0 })!;
    const correlated = ratioOfMeans({ ...base, covariance: 20 })!;
    expect(independent.ratio).toBe(15);
    expectClose(independent.standardError, Math.sqrt((400 + 225 * 1.5) / (500 * 4)), 1e-14);
    expectClose(
      correlated.standardError,
      Math.sqrt((400 - 2 * 15 * 20 + 225 * 1.5) / (500 * 4)),
      1e-14,
    );
    expect(correlated.interval.upper - correlated.interval.lower).toBeLessThan(
      independent.interval.upper - independent.interval.lower,
    );
  });

  it('is null for a zero denominator or n < 2, and refuses bad input', () => {
    const q = { n: 10, meanX: 1, meanY: 0, varianceX: 1, varianceY: 1, covariance: 0 };
    expect(ratioOfMeans(q)).toBeNull();
    expect(ratioOfMeans({ ...q, meanY: 1, n: 1 })).toBeNull();
    expect(() => ratioOfMeans({ ...q, varianceX: -1 })).toThrow(RangeError);
    expect(() => ratioOfMeans({ ...q, covariance: NaN })).toThrow(RangeError);
    expect(() => ratioOfMeans({ ...q, n: 2.5 })).toThrow(RangeError);
  });

  it('covers the true ratio 95% of the time', () => {
    // Orders per user Y ~ 1 + Poisson-ish, revenue X = Y × price around 10.
    const random = seeded(23);
    const runs = 1500;
    let covered = 0;
    for (let r = 0; r < runs; r++) {
      const n = 400;
      let sx = 0;
      let sy = 0;
      let sxx = 0;
      let syy = 0;
      let sxy = 0;
      for (let i = 0; i < n; i++) {
        const y = 1 + Math.floor(random() * 4);
        const x = y * (5 + 10 * random());
        sx += x;
        sy += y;
        sxx += x * x;
        syy += y * y;
        sxy += x * y;
      }
      const mx = sx / n;
      const my = sy / n;
      const result = ratioOfMeans({
        n,
        meanX: mx,
        meanY: my,
        varianceX: (sxx - n * mx * mx) / (n - 1),
        varianceY: (syy - n * my * my) / (n - 1),
        covariance: (sxy - n * mx * my) / (n - 1),
      })!;
      if (result.interval.lower <= 10 && 10 <= result.interval.upper) covered++;
    }
    expect(covered / runs).toBeGreaterThan(0.93);
    expect(covered / runs).toBeLessThan(0.97);
  });
});

describe('Wilson interval', () => {
  it.each([
    [81, 263, 0.2552885198782742, 0.36620957698280004],
    [0, 20, 0, 0.16112515805281938],
    [20, 20, 0.8388748419471806, 1],
    [500, 10000, 0.04589848269058477, 0.05444711584302416],
  ])('%d of %d', (k, n, lower, upper) => {
    const r = wilsonInterval(k, n)!;
    expectClose(r.lower, lower, 1e-13);
    expectClose(r.upper, upper, 1e-13);
  });

  it('is null for no trials and refuses bad counts', () => {
    expect(wilsonInterval(0, 0)).toBeNull();
    expect(() => wilsonInterval(5, 4)).toThrow(RangeError);
    expect(() => wilsonInterval(-1, 4)).toThrow(RangeError);
    expect(() => wilsonInterval(1, 2.5)).toThrow(RangeError);
    expect(() => wilsonInterval(1, 4, { confidence: 2 })).toThrow(RangeError);
  });
});

describe('sample ratio mismatch', () => {
  it('matches SciPy on a 50/50 split', () => {
    const r = sampleRatioMismatch([50550, 49450], [50, 50]);
    expectClose(r.statistic, 12.1, 1e-13);
    expect(r.df).toBe(1);
    expectClose(r.pValue, 0.0005042182294490053, 1e-11);
    expect(r.mismatch).toBe(true);
    expect(r.expected).toEqual([50000, 50000]);
  });

  it('matches SciPy on three groups and on uneven weights', () => {
    const three = sampleRatioMismatch([3300, 3300, 3600], [1, 1, 1]);
    expectClose(three.statistic, 17.647058823529413, 1e-13);
    expectClose(three.pValue, 0.00014722781458154492, 1e-11);
    expect(three.mismatch).toBe(true);
    const uneven = sampleRatioMismatch([9000, 1100], [90, 10]);
    expectClose(uneven.statistic, 8.910891089108912, 1e-13);
    expectClose(uneven.pValue, 0.002834749080259389, 1e-11);
    // Suspicious but above p 0.001: not flagged by default, flagged at 0.01.
    expect(uneven.mismatch).toBe(false);
    expect(sampleRatioMismatch([9000, 1100], [90, 10], { threshold: 0.01 }).mismatch).toBe(true);
  });

  it('passes a fair split', () => {
    const r = sampleRatioMismatch([5012, 4988], [1, 1]);
    expect(r.pValue).toBeGreaterThan(0.5);
    expect(r.mismatch).toBe(false);
  });

  it('ignores empty zero-weight groups and flags traffic in one', () => {
    const r = sampleRatioMismatch([500, 0, 500], [50, 0, 50]);
    expect(r.df).toBe(1);
    expect(r.statistic).toBe(0);
    expect(r.pValue).toBe(1);
    const leak = sampleRatioMismatch([500, 3, 500], [50, 0, 50]);
    expect(leak).toMatchObject({ pValue: 0, mismatch: true, statistic: Infinity });
  });

  it('cannot mismatch with no traffic or a single group', () => {
    expect(sampleRatioMismatch([0, 0], [1, 1])).toMatchObject({ pValue: 1, mismatch: false });
    expect(sampleRatioMismatch([42], [100])).toMatchObject({ df: 0, pValue: 1, mismatch: false });
  });

  it('refuses bad input', () => {
    expect(() => sampleRatioMismatch([1, 2], [1])).toThrow(RangeError);
    expect(() => sampleRatioMismatch([1, 2], [0, 0])).toThrow(RangeError);
    expect(() => sampleRatioMismatch([1, -2], [1, 1])).toThrow(RangeError);
    expect(() => sampleRatioMismatch([1.5, 2], [1, 1])).toThrow(RangeError);
    expect(() => sampleRatioMismatch([1, 2], [1, NaN])).toThrow(RangeError);
    expect(() => sampleRatioMismatch([1, 2], [1, -1])).toThrow(RangeError);
    expect(() => sampleRatioMismatch([1, 2], [1, 1], { threshold: 0 })).toThrow(RangeError);
  });

  it('flags a 50.6/49.4 split of 100,000 contexts but stays quiet on a fair split about 999 times in 1,000', () => {
    expect(sampleRatioMismatch([50600, 49400], [1, 1]).mismatch).toBe(true);
    const random = seeded(3);
    let alarms = 0;
    for (let i = 0; i < 1000; i++) {
      let a = 0;
      for (let j = 0; j < 2000; j++) if (random() < 0.5) a++;
      if (sampleRatioMismatch([a, 2000 - a], [1, 1]).mismatch) alarms++;
    }
    expect(alarms).toBeLessThanOrEqual(4);
  });
});
