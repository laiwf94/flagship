/**
 * Special functions behind the distributions: the log gamma function and the
 * regularized incomplete gamma and beta functions. Accurate to about 1e-14
 * relative over the ranges experiments use; the tests check them against
 * tabulated values.
 */

const EPS = 1e-16;
const TINY = 1e-300;
const MAX_ITERATIONS = 100_000;

// Lanczos approximation, g = 7, n = 9 (Godfrey's coefficients).
const LANCZOS_G = 7;
const LANCZOS = [
  0.9999999999998099, 676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406,
  12.507343278686905, -0.13857109526572012, 0.000009984369578019572, 1.5056327351493116e-7,
];
const HALF_LOG_2PI = 0.5 * Math.log(2 * Math.PI);

/** ln Γ(x) for x > 0. */
export function logGamma(x: number): number {
  if (!(x > 0) || !Number.isFinite(x)) throw new RangeError(`logGamma needs x > 0, got ${x}`);
  if (x < 0.5) {
    // Reflection: Γ(x)Γ(1−x) = π / sin(πx), and sin(πx) > 0 on (0, 0.5).
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const z = x - 1;
  let sum = LANCZOS[0] as number;
  for (let i = 1; i < LANCZOS.length; i++) sum += (LANCZOS[i] as number) / (z + i);
  const t = z + LANCZOS_G + 0.5;
  return HALF_LOG_2PI + (z + 0.5) * Math.log(t) - t + Math.log(sum);
}

/** δ(x) = ln Γ(x) − ((x − ½)·ln x − x + ½·ln 2π), by its asymptotic series; for x ≥ 10. */
function stirlingCorrection(x: number): number {
  const x2 = x * x;
  // Bernoulli terms B₂ₖ / (2k(2k − 1)·x^(2k−1)), k = 1..7; the next is below 1e-16 at x = 10.
  return (
    (1 / 12 -
      (1 / 360 -
        (1 / 1260 - (1 / 1680 - (1 / 1188 - (691 / 360360 - 1 / 156 / x2) / x2) / x2) / x2) / x2) /
        x2) /
    x
  );
}

/**
 * ln B(a, b) = ln Γ(a) + ln Γ(b) − ln Γ(a + b). When one argument is large the
 * three log gammas are huge and nearly cancel, so the difference is formed
 * from Stirling's series instead (this is what keeps t tails accurate at
 * millions of degrees of freedom).
 */
export function logBeta(a: number, b: number): number {
  const big = Math.max(a, b);
  const small = Math.min(a, b);
  if (big < 10) return logGamma(a) + logGamma(b) - logGamma(a + b);
  const sum = big + small;
  // ln Γ(big + small) − ln Γ(big) without cancellation.
  const ratio =
    (big - 0.5) * Math.log1p(small / big) +
    small * Math.log(sum) -
    small +
    stirlingCorrection(sum) -
    stirlingCorrection(big);
  return logGamma(small) - ratio;
}

function checkGammaArgs(a: number, x: number): void {
  if (!(a > 0) || !Number.isFinite(a)) throw new RangeError(`gamma needs a > 0, got ${a}`);
  if (!(x >= 0) || Number.isNaN(x)) throw new RangeError(`gamma needs x >= 0, got ${x}`);
}

/** Series for P(a, x), good for x < a + 1. */
function gammaSeries(a: number, x: number): number {
  let ap = a;
  let term = 1 / a;
  let sum = term;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    ap += 1;
    term *= x / ap;
    sum += term;
    if (Math.abs(term) < Math.abs(sum) * EPS) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
}

/** Continued fraction for Q(a, x) (modified Lentz), good for x ≥ a + 1. */
function gammaFraction(a: number, x: number): number {
  let b = x + 1 - a;
  let c = 1 / TINY;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < MAX_ITERATIONS; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < TINY) d = TINY;
    c = b + an / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPS) break;
  }
  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

/** Regularized lower incomplete gamma P(a, x) = γ(a, x) / Γ(a). */
export function gammaP(a: number, x: number): number {
  checkGammaArgs(a, x);
  if (x === 0) return 0;
  if (x === Infinity) return 1;
  return x < a + 1 ? gammaSeries(a, x) : 1 - gammaFraction(a, x);
}

/** Regularized upper incomplete gamma Q(a, x) = 1 − P(a, x), accurate in the tail. */
export function gammaQ(a: number, x: number): number {
  checkGammaArgs(a, x);
  if (x === 0) return 1;
  if (x === Infinity) return 0;
  return x < a + 1 ? 1 - gammaSeries(a, x) : gammaFraction(a, x);
}

/** Continued fraction for I_x(a, b) (modified Lentz). */
function betaFraction(a: number, b: number, x: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m < MAX_ITERATIONS; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPS) break;
  }
  return h;
}

/**
 * Regularized incomplete beta I_x(a, b) for a, b > 0 and 0 ≤ x ≤ 1. Pass `y`
 * when 1 − x is known more precisely than the subtraction gives (x near 1).
 */
export function betaI(a: number, b: number, x: number, y = 1 - x): number {
  if (!(a > 0) || !(b > 0) || !Number.isFinite(a) || !Number.isFinite(b)) {
    throw new RangeError(`betaI needs a, b > 0, got ${a}, ${b}`);
  }
  if (!(x >= 0 && x <= 1) || !(y >= 0 && y <= 1)) {
    throw new RangeError(`betaI needs 0 <= x <= 1, got ${x}`);
  }
  if (x === 0) return 0;
  if (y === 0) return 1;
  // ln x and ln(1 − x) through log1p of the smaller one, for x near 0 or 1.
  const logX = x > 0.5 ? Math.log1p(-y) : Math.log(x);
  const logY = y > 0.5 ? Math.log1p(-x) : Math.log(y);
  const front = Math.exp(a * logX + b * logY - logBeta(a, b));
  // The fraction converges fast on the side of the mean; use symmetry on the other.
  if (x < (a + 1) / (a + b + 2)) return (front * betaFraction(a, b, x)) / a;
  return 1 - (front * betaFraction(b, a, y)) / b;
}
