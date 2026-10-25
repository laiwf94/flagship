import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { bucketOf, bucketValue, pickVariant } from './bucket.js';
import { ROLLOUT_TOTAL, type Rollout } from './model.js';

const twoWay = (on: number): Rollout => ({
  variants: [
    { variant: 'on', weight: on },
    { variant: 'off', weight: ROLLOUT_TOTAL - on },
  ],
});

const keys = (n: number) => Array.from({ length: n }, (_, i) => `user-${i}`);

describe('bucketOf', () => {
  it('is stable and in range', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (salt, key) => {
        const b = bucketOf(salt, key);
        expect(b).toBe(bucketOf(salt, key));
        expect(Number.isInteger(b) && b >= 0 && b < ROLLOUT_TOTAL).toBe(true);
      }),
    );
  });

  it('pins known buckets so every SDK can check itself against these numbers', () => {
    expect(bucketOf('new-checkout', 'alice')).toMatchInlineSnapshot(`90840`);
    expect(bucketOf('new-checkout', 'bob')).toMatchInlineSnapshot(`29088`);
    expect(bucketOf('dark-mode', 'alice')).toMatchInlineSnapshot(`89895`);
  });
});

describe('pickVariant', () => {
  it('walks cumulative ranges', () => {
    const r: Rollout = {
      variants: [
        { variant: 'a', weight: 10_000 },
        { variant: 'b', weight: 0 },
        { variant: 'c', weight: 90_000 },
      ],
    };
    expect(pickVariant(r, 0)).toBe('a');
    expect(pickVariant(r, 9_999)).toBe('a');
    expect(pickVariant(r, 10_000)).toBe('c');
    expect(pickVariant(r, ROLLOUT_TOTAL - 1)).toBe('c');
    expect(pickVariant(r, ROLLOUT_TOTAL + 5)).toBe('c');
  });

  it('keeps everyone who was on when the percentage grows', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.uniqueArray(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 200 }),
        fc.nat(ROLLOUT_TOTAL),
        fc.nat(ROLLOUT_TOTAL),
        (salt, users, x, y) => {
          const [p1, p2] = x <= y ? [x, y] : [y, x];
          for (const u of users) {
            const b = bucketOf(salt, u);
            if (pickVariant(twoWay(p1), b) === 'on') expect(pickVariant(twoWay(p2), b)).toBe('on');
            if (pickVariant(twoWay(p2), b) === 'off')
              expect(pickVariant(twoWay(p1), b)).toBe('off');
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it('splits 100k users within one percentage point of the weights', () => {
    const users = keys(100_000);
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 2, maxLength: 5 }),
        (salt, raw) => {
          const total = raw.reduce((a, b) => a + b, 0);
          const weights = raw.map((w) => Math.floor((w / total) * ROLLOUT_TOTAL));
          weights[0] = (weights[0] ?? 0) + ROLLOUT_TOTAL - weights.reduce((a, b) => a + b, 0);
          const rollout: Rollout = {
            variants: weights.map((weight, i) => ({ variant: `v${i}`, weight })),
          };
          const counts = new Map<string, number>();
          for (const u of users) {
            const v = pickVariant(rollout, bucketOf(salt, u)) ?? '';
            counts.set(v, (counts.get(v) ?? 0) + 1);
          }
          weights.forEach((w, i) => {
            const observed = (counts.get(`v${i}`) ?? 0) / users.length;
            expect(Math.abs(observed - w / ROLLOUT_TOTAL)).toBeLessThan(0.01);
          });
        },
      ),
      { numRuns: 8 },
    );
  });

  it('buckets independently under different salts', () => {
    const users = keys(100_000);
    const half = twoWay(ROLLOUT_TOTAL / 2);
    let both = 0;
    for (const u of users) {
      const a = pickVariant(half, bucketOf('flag-a', u)) === 'on';
      const b = pickVariant(half, bucketOf('flag-b', u)) === 'on';
      if (a && b) both++;
    }
    expect(Math.abs(both / users.length - 0.25)).toBeLessThan(0.01);
  });
});

describe('bucketValue', () => {
  const ctx = { key: 'alice', org: 'acme', seat: 42, beta: true, tags: ['x'], empty: '' };
  it('uses the key by default', () => {
    expect(bucketValue(ctx, undefined)).toBe('alice');
    expect(bucketValue(ctx, 'key')).toBe('alice');
  });
  it('uses a string or number attribute when present', () => {
    expect(bucketValue(ctx, 'org')).toBe('acme');
    expect(bucketValue(ctx, 'seat')).toBe('42');
  });
  it('falls back to the key for missing, empty or non-scalar attributes', () => {
    expect(bucketValue(ctx, 'missing')).toBe('alice');
    expect(bucketValue(ctx, 'beta')).toBe('alice');
    expect(bucketValue(ctx, 'tags')).toBe('alice');
    expect(bucketValue(ctx, 'empty')).toBe('alice');
    expect(bucketValue(ctx, 'constructor')).toBe('alice');
  });
});
