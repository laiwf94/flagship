import { betaI, gammaP, gammaQ, logGamma } from './special.js';

/**
 * The normal, chi-square and Student's t distributions: density, lower and
 * upper tail (`cdf`, `sf`, each accurate in its own tail) and quantile.
 */

function checkProbability(p: number): void {
  if (!(p >= 0 && p <= 1)) throw new RangeError(`probability must be in [0, 1], got ${p}`);
}

function checkDf(df: number): void {
  if (!(df > 0) || Number.isNaN(df))
    throw new RangeError(`degrees of freedom must be > 0, got ${df}`);
}

// ---------------------------------------------------------------- normal

const SQRT2 = Math.SQRT2;
const LOG_SQRT_2PI = 0.5 * Math.log(2 * Math.PI);

/** erfc(z) for z ≥ 0, through erfc(z) = Q(1/2, z²), so the tail keeps its relative accuracy. */
function erfcNonNegative(z: number): number {
  return gammaQ(0.5, z * z);
}

/** Standard normal density. */
export function normalPdf(x: number): number {
  return Math.exp(-0.5 * x * x - LOG_SQRT_2PI);
}

/** Standard normal P(X ≤ x). */
export function normalCdf(x: number): number {
  if (Number.isNaN(x)) return NaN;
  return x < 0 ? 0.5 * erfcNonNegative(-x / SQRT2) : 1 - 0.5 * erfcNonNegative(x / SQRT2);
}

/** Standard normal P(X > x). */
export function normalSf(x: number): number {
  return normalCdf(-x);
}

/**
 * Standard normal quantile: Wichura's algorithm AS 241 (PPND16), accurate to
 * about 1e-16 relative.
 */
export function normalQuantile(p: number): number {
  checkProbability(p);
  if (p === 0) return -Infinity;
  if (p === 1) return Infinity;
  const q = p - 0.5;
  if (Math.abs(q) <= 0.425) {
    const r = 0.180625 - q * q;
    return (
      (q *
        (((((((r * 2509.0809287301227 + 33430.57558358813) * r + 67265.7709270087) * r +
          45921.95393154987) *
          r +
          13731.69376550946) *
          r +
          1971.5909503065513) *
          r +
          133.14166789178438) *
          r +
          3.3871328727963665)) /
      (((((((r * 5226.495278852546 + 28729.085735721943) * r + 39307.89580009271) * r +
        21213.794301586597) *
        r +
        5394.196021424751) *
        r +
        687.1870074920579) *
        r +
        42.31333070160091) *
        r +
        1)
    );
  }
  let r = q < 0 ? p : 1 - p;
  r = Math.sqrt(-Math.log(r));
  let x: number;
  if (r <= 5) {
    r -= 1.6;
    x =
      (((((((r * 0.0007745450142783414 + 0.022723844989269184) * r + 0.2417807251774506) * r +
        1.2704582524523684) *
        r +
        3.6478483247632045) *
        r +
        5.769497221460691) *
        r +
        4.630337846156546) *
        r +
        1.4234371107496835) /
      (((((((r * 1.0507500716444169e-9 + 0.0005475938084995345) * r + 0.015198666563616457) * r +
        0.14810397642748008) *
        r +
        0.6897673349851) *
        r +
        1.6763848301838038) *
        r +
        2.053191626637759) *
        r +
        1);
  } else {
    r -= 5;
    x =
      (((((((r * 2.0103343992922881e-7 + 0.000027115555687434876) * r + 0.0012426609473880784) * r +
        0.026532189526576124) *
        r +
        0.29656057182850487) *
        r +
        1.7848265399172913) *
        r +
        5.463784911164114) *
        r +
        6.657904643501103) /
      (((((((r * 2.0442631033899397e-15 + 1.421511758316446e-7) * r + 0.000018463183175100548) * r +
        0.0007868691311456133) *
        r +
        0.014875361290850615) *
        r +
        0.1369298809227358) *
        r +
        0.599832206555888) *
        r +
        1);
  }
  return q < 0 ? -x : x;
}

// ------------------------------------------------------------ chi-square

/** Chi-square density with `df` degrees of freedom. */
export function chiSquarePdf(x: number, df: number): number {
  checkDf(df);
  if (x < 0) return 0;
  const k = df / 2;
  if (x === 0) return k < 1 ? Infinity : k === 1 ? 0.5 : 0;
  return Math.exp((k - 1) * Math.log(x) - x / 2 - k * Math.LN2 - logGamma(k));
}

/** Chi-square P(X ≤ x). */
export function chiSquareCdf(x: number, df: number): number {
  checkDf(df);
  if (Number.isNaN(x)) return NaN;
  return x <= 0 ? 0 : gammaP(df / 2, x / 2);
}

/** Chi-square P(X > x), the p-value of a chi-square statistic. */
export function chiSquareSf(x: number, df: number): number {
  checkDf(df);
  if (Number.isNaN(x)) return NaN;
  return x <= 0 ? 1 : gammaQ(df / 2, x / 2);
}

/** Chi-square quantile: the x with P(X ≤ x) = p. */
export function chiSquareQuantile(p: number, df: number): number {
  checkProbability(p);
  checkDf(df);
  if (p === 0) return 0;
  if (p === 1) return Infinity;
  // Wilson–Hilferty start, then a safeguarded Newton solve.
  const z = normalQuantile(p);
  const c = 2 / (9 * df);
  const start = Math.max(df * (1 - c + z * Math.sqrt(c)) ** 3, Number.MIN_VALUE);
  return solve(
    p > 0.5 ? 1 - p : p,
    p > 0.5,
    (x) => chiSquareCdf(x, df),
    (x) => chiSquareSf(x, df),
    (x) => chiSquarePdf(x, df),
    0,
    start,
  );
}

// ------------------------------------------------------------ Student's t

/** Student's t density with `df` degrees of freedom. */
export function studentTPdf(t: number, df: number): number {
  checkDf(df);
  if (df === Infinity) return normalPdf(t);
  return Math.exp(
    logGamma((df + 1) / 2) -
      logGamma(df / 2) -
      0.5 * Math.log(df * Math.PI) -
      ((df + 1) / 2) * Math.log1p((t * t) / df),
  );
}

/** Student's t P(T > t). */
export function studentTSf(t: number, df: number): number {
  checkDf(df);
  if (Number.isNaN(t)) return NaN;
  if (df === Infinity) return normalSf(t);
  if (t === Infinity) return 0;
  if (t === -Infinity) return 1;
  const t2 = t * t;
  // P(|T| > |t|) = I_x(df/2, 1/2) with x = df / (df + t²); 1 − x is passed exactly.
  const tail = 0.5 * betaI(df / 2, 0.5, df / (df + t2), t2 / (df + t2));
  return t >= 0 ? tail : 1 - tail;
}

/** Student's t P(T ≤ t). */
export function studentTCdf(t: number, df: number): number {
  return studentTSf(-t, df);
}

/** Student's t quantile: the t with P(T ≤ t) = p. */
export function studentTQuantile(p: number, df: number): number {
  checkProbability(p);
  checkDf(df);
  if (p === 0) return -Infinity;
  if (p === 1) return Infinity;
  if (p === 0.5) return 0;
  if (df === Infinity) return normalQuantile(p);
  // Symmetric: solve for the upper tail probability q = min(p, 1 − p), which is
  // exact as given, and mirror. Forming 1 − p for small p would lose its digits.
  const q = p > 0.5 ? 1 - p : p;
  let start: number;
  if (df === 1) start = 1 / Math.tan(Math.PI * q);
  else if (df === 2) start = (1 - 2 * q) / Math.sqrt(2 * q * (1 - q));
  else {
    // Cornish–Fisher expansion around the normal quantile.
    const z = -normalQuantile(q);
    const z3 = z * z * z;
    start = z + (z3 + z) / (4 * df) + (5 * z3 * z * z + 16 * z3 + 3 * z) / (96 * df * df);
  }
  const t = solve(
    q,
    true,
    (x) => studentTCdf(x, df),
    (x) => studentTSf(x, df),
    (x) => studentTPdf(x, df),
    0,
    start,
  );
  return p > 0.5 ? t : -t;
}

// ------------------------------------------------------------------ solve

/**
 * Finds x ≥ lo where the lower tail (or, with `upper`, the upper tail) equals
 * `target`, by Newton steps kept inside a bracket that bisection narrows
 * whenever a step would leave it. Upper tails are matched on the survival
 * function so small ones keep their precision.
 */
function solve(
  target: number,
  upper: boolean,
  cdf: (x: number) => number,
  sf: (x: number) => number,
  pdf: (x: number) => number,
  lo: number,
  start: number,
): number {
  // f is increasing in x either way.
  const f = (x: number): number => (upper ? target - sf(x) : cdf(x) - target);
  let low = lo;
  let high = Math.max(start, lo + 1);
  while (f(high) < 0) {
    low = high;
    high *= 2;
  }
  let x = Math.min(Math.max(start, low), high);
  for (let i = 0; i < 200; i++) {
    const fx = f(x);
    if (fx === 0) return x;
    if (fx < 0) low = x;
    else high = x;
    const density = pdf(x);
    let next = density > 0 ? x - fx / density : NaN;
    if (!(next > low && next < high)) next = (low + high) / 2;
    if (Math.abs(next - x) <= 1e-15 * Math.abs(x) || high - low <= 1e-15 * high) return next;
    x = next;
  }
  return x;
}
