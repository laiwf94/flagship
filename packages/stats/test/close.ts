import { expect } from 'vitest';

/** Asserts |actual − expected| ≤ rel·|expected| (or ≤ rel when expected is 0). */
export function expectClose(actual: number, expected: number, rel = 1e-12): void {
  const tolerance = expected === 0 ? rel : rel * Math.abs(expected);
  if (!(Math.abs(actual - expected) <= tolerance)) {
    expect.fail(`expected ${actual} to be within ${rel} (relative) of ${expected}`);
  }
}

/** Small seeded generator (mulberry32) so simulations are repeatable. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
