import {
  chiSquareSf,
  normalQuantile,
  normalSf,
  studentTQuantile,
  studentTSf,
} from './distributions.js';

/** A sample summarized by its size, mean and (n − 1) sample variance. */
export interface Summary {
  n: number;
  mean: number;
  variance: number;
}

export interface Interval {
  lower: number;
  upper: number;
}

export interface ConfidenceOptions {
  /** Two-sided confidence level, 0.95 unless given. */
  confidence?: number;
}

function checkConfidence(confidence: number): number {
  if (!(confidence > 0 && confidence < 1)) {
    throw new RangeError(`confidence must be in (0, 1), got ${confidence}`);
  }
  return confidence;
}

function checkFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite, got ${value}`);
}

function checkSummary(s: Summary): void {
  if (!Number.isInteger(s.n) || s.n < 0)
    throw new RangeError(`n must be a whole number >= 0, got ${s.n}`);
  checkFinite('mean', s.mean);
  checkFinite('variance', s.variance);
  if (s.variance < 0) throw new RangeError(`variance must be >= 0, got ${s.variance}`);
}

/**
 * Summary of n values from their sum and sum of squares, the shape the hourly
 * rollup keeps per variant (contexts that never converted count as 0). A
 * 0/1 metric such as "converted" has sum = sum of squares = the count.
 */
export function summarize(n: number, sum: number, sumOfSquares: number): Summary {
  if (!Number.isInteger(n) || n < 0)
    throw new RangeError(`n must be a whole number >= 0, got ${n}`);
  checkFinite('sum', sum);
  checkFinite('sumOfSquares', sumOfSquares);
  if (n === 0) return { n, mean: 0, variance: 0 };
  const mean = sum / n;
  if (n === 1) return { n, mean, variance: 0 };
  // Rounding can take a constant sample's spread a hair below zero.
  const variance = Math.max(0, (sumOfSquares - sum * mean) / (n - 1));
  return { n, mean, variance };
}

export interface WelchResult {
  /** treatment.mean − control.mean */
  difference: number;
  standardError: number;
  /** Welch–Satterthwaite degrees of freedom. */
  df: number;
  t: number;
  /** Two-sided p-value. */
  pValue: number;
  /** Confidence interval for the difference. */
  interval: Interval;
}

/**
 * Welch's unequal-variance t-test of treatment against control, with a
 * confidence interval for the difference in means. Null when either side has
 * fewer than two values, where no variance can be estimated.
 */
export function welchTTest(
  control: Summary,
  treatment: Summary,
  options: ConfidenceOptions = {},
): WelchResult | null {
  checkSummary(control);
  checkSummary(treatment);
  const confidence = checkConfidence(options.confidence ?? 0.95);
  if (control.n < 2 || treatment.n < 2) return null;
  const difference = treatment.mean - control.mean;
  const vc = control.variance / control.n;
  const vt = treatment.variance / treatment.n;
  const se2 = vc + vt;
  if (se2 === 0) {
    // Both sides constant: the difference is known exactly.
    return {
      difference,
      standardError: 0,
      df: control.n + treatment.n - 2,
      t: difference === 0 ? 0 : difference > 0 ? Infinity : -Infinity,
      pValue: difference === 0 ? 1 : 0,
      interval: { lower: difference, upper: difference },
    };
  }
  const standardError = Math.sqrt(se2);
  const df = (se2 * se2) / ((vc * vc) / (control.n - 1) + (vt * vt) / (treatment.n - 1));
  const t = difference / standardError;
  const pValue = Math.min(1, 2 * studentTSf(Math.abs(t), df));
  const critical = studentTQuantile(1 - (1 - confidence) / 2, df);
  return {
    difference,
    standardError,
    df,
    t,
    pValue,
    interval: {
      lower: difference - critical * standardError,
      upper: difference + critical * standardError,
    },
  };
}

export interface LiftResult {
  /** treatment.mean / control.mean − 1 */
  lift: number;
  /** Delta-method standard error of the lift. */
  standardError: number;
  /** Two-sided p-value of lift = 0 on the normal approximation. */
  pValue: number;
  interval: Interval;
}

/**
 * Relative lift of treatment over control with a delta-method interval:
 * Var(T̄/C̄) ≈ Var(T̄)/μc² + μt²·Var(C̄)/μc⁴ for independent groups. Null when
 * the control mean is 0 (no lift is defined) or a side has fewer than two
 * values.
 */
export function relativeLift(
  control: Summary,
  treatment: Summary,
  options: ConfidenceOptions = {},
): LiftResult | null {
  checkSummary(control);
  checkSummary(treatment);
  const confidence = checkConfidence(options.confidence ?? 0.95);
  if (control.n < 2 || treatment.n < 2 || control.mean === 0) return null;
  const mc = control.mean;
  const mt = treatment.mean;
  const ratio = mt / mc;
  const variance =
    treatment.variance / treatment.n / (mc * mc) +
    (ratio * ratio * control.variance) / control.n / (mc * mc);
  const standardError = Math.sqrt(variance);
  const lift = ratio - 1;
  const z = normalQuantile(1 - (1 - confidence) / 2);
  const pValue =
    standardError === 0
      ? lift === 0
        ? 1
        : 0
      : Math.min(1, 2 * normalSf(Math.abs(lift / standardError)));
  return {
    lift,
    standardError,
    pValue,
    interval: { lower: lift - z * standardError, upper: lift + z * standardError },
  };
}

/**
 * Delta-method interval for a ratio of two per-unit means within one group,
 * such as revenue per order when both vary by user:
 * Var(X̄/Ȳ) ≈ (Var(X) − 2R·Cov(X, Y) + R²·Var(Y)) / (n·μy²), R = μx/μy.
 * Null when the denominator mean is 0 or n < 2.
 */
export function ratioOfMeans(
  q: {
    n: number;
    meanX: number;
    meanY: number;
    varianceX: number;
    varianceY: number;
    covariance: number;
  },
  options: ConfidenceOptions = {},
): { ratio: number; standardError: number; interval: Interval } | null {
  if (!Number.isInteger(q.n) || q.n < 0)
    throw new RangeError(`n must be a whole number >= 0, got ${q.n}`);
  for (const k of ['meanX', 'meanY', 'varianceX', 'varianceY', 'covariance'] as const)
    checkFinite(k, q[k]);
  if (q.varianceX < 0 || q.varianceY < 0) throw new RangeError('variances must be >= 0');
  const confidence = checkConfidence(options.confidence ?? 0.95);
  if (q.n < 2 || q.meanY === 0) return null;
  const ratio = q.meanX / q.meanY;
  const variance = Math.max(
    0,
    (q.varianceX - 2 * ratio * q.covariance + ratio * ratio * q.varianceY) /
      (q.n * q.meanY * q.meanY),
  );
  const standardError = Math.sqrt(variance);
  const z = normalQuantile(1 - (1 - confidence) / 2);
  return {
    ratio,
    standardError,
    interval: { lower: ratio - z * standardError, upper: ratio + z * standardError },
  };
}

/**
 * Wilson score interval for a proportion `successes / n`. Unlike the plain
 * normal interval it stays inside [0, 1] and is sensible at 0 or n successes.
 * Null when n = 0.
 */
export function wilsonInterval(
  successes: number,
  n: number,
  options: ConfidenceOptions = {},
): Interval | null {
  if (!Number.isInteger(n) || n < 0)
    throw new RangeError(`n must be a whole number >= 0, got ${n}`);
  if (!Number.isInteger(successes) || successes < 0 || successes > n) {
    throw new RangeError(`successes must be a whole number in [0, n], got ${successes}`);
  }
  const confidence = checkConfidence(options.confidence ?? 0.95);
  if (n === 0) return null;
  const z = normalQuantile(1 - (1 - confidence) / 2);
  const z2 = z * z;
  const p = successes / n;
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  // At 0 or n successes the matching bound is exactly 0 or 1; avoid rounding past it.
  return {
    lower: successes === 0 ? 0 : Math.max(0, centre - half),
    upper: successes === n ? 1 : Math.min(1, centre + half),
  };
}

export interface SampleRatioResult {
  /** Pearson chi-square statistic. */
  statistic: number;
  df: number;
  pValue: number;
  /** pValue < threshold: the split is not what the weights say, so results can't be trusted. */
  mismatch: boolean;
  /** Expected count per group, in input order. */
  expected: number[];
}

/**
 * Sample ratio mismatch check: a chi-square goodness-of-fit test of the
 * observed group sizes against the configured weights. Groups with zero
 * weight and zero observations are left out; any observation in a zero-weight
 * group is a certain mismatch. The default threshold is p < 0.001, strict
 * because the check runs on every experiment and a false alarm hides results.
 */
export function sampleRatioMismatch(
  observed: readonly number[],
  weights: readonly number[],
  options: { threshold?: number } = {},
): SampleRatioResult {
  if (observed.length !== weights.length) {
    throw new RangeError(
      `observed has ${observed.length} groups but weights has ${weights.length}`,
    );
  }
  const threshold = options.threshold ?? 0.001;
  if (!(threshold > 0 && threshold < 1))
    throw new RangeError(`threshold must be in (0, 1), got ${threshold}`);
  let total = 0;
  let weightTotal = 0;
  for (let i = 0; i < observed.length; i++) {
    const o = observed[i] as number;
    const w = weights[i] as number;
    if (!Number.isInteger(o) || o < 0)
      throw new RangeError(`observed counts must be whole numbers >= 0, got ${o}`);
    if (!(w >= 0) || !Number.isFinite(w))
      throw new RangeError(`weights must be finite and >= 0, got ${w}`);
    total += o;
    weightTotal += w;
  }
  if (weightTotal === 0) throw new RangeError('weights must not all be 0');
  const expected = weights.map((w) => (total * w) / weightTotal);
  let statistic = 0;
  let groups = 0;
  let impossible = false;
  for (let i = 0; i < observed.length; i++) {
    const o = observed[i] as number;
    const e = expected[i] as number;
    if (e === 0) {
      if (o > 0) impossible = true;
      continue;
    }
    groups++;
    statistic += ((o - e) * (o - e)) / e;
  }
  const df = Math.max(groups - 1, 0);
  if (impossible) return { statistic: Infinity, df, pValue: 0, mismatch: true, expected };
  const pValue = df === 0 || total === 0 ? 1 : chiSquareSf(statistic, df);
  return { statistic, df, pValue, mismatch: pValue < threshold, expected };
}
