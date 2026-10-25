import { murmur3 } from './hash.js';
import { ROLLOUT_TOTAL, own, type Context, type Rollout } from './model.js';

/**
 * Bucket in [0, ROLLOUT_TOTAL) for a value under a flag's salt.
 *
 * The modulo has a bias of 2^32 mod 100,000 = 67,296 buckets getting one extra
 * hash value out of about 42,950, a relative skew of 2.3e-5. That is far below
 * anything a rollout can observe, so we keep the simple form.
 */
export function bucketOf(salt: string, value: string): number {
  return murmur3(`${salt}:${value}`) % ROLLOUT_TOTAL;
}

/**
 * The string a context is bucketed by. A missing or non-scalar `bucketBy`
 * attribute falls back to the context key, so the result is still stable.
 */
export function bucketValue(context: Context, bucketBy: string | undefined): string {
  if (bucketBy === undefined || bucketBy === 'key') return context.key;
  const v = own(context, bucketBy);
  if (typeof v === 'string' && v.length > 0) return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return context.key;
}

/**
 * Walks the cumulative weight ranges in declared order. With variants
 * [on: p, off: 100% - p], a context is "on" exactly when its bucket is below p,
 * so raising p only adds contexts; nobody already "on" flips back.
 */
export function pickVariant(rollout: Rollout, bucket: number): string | undefined {
  let upper = 0;
  for (const wv of rollout.variants) {
    upper += wv.weight;
    if (bucket < upper) return wv.variant;
  }
  return rollout.variants.at(-1)?.variant;
}
