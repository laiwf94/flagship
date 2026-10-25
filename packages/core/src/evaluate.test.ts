import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { rulesetArb } from '../test/arbitraries.js';
import { booleanFlag, ruleset, segment } from '../test/fixtures.js';
import { bucketOf } from './bucket.js';
import { evaluate, evaluateAll, inSegment, type Evaluation } from './evaluate.js';
import {
  ROLLOUT_TOTAL,
  own,
  type AttributeClause,
  type Clause,
  type Context,
  type Flag,
  type Ruleset,
  type Serve,
} from './model.js';
import { validateRuleset } from './validate.js';

const variantOf = (e: Evaluation) => (e.reason === 'ERROR' ? `ERROR:${e.errorCode}` : e.variant);

const beta = { id: 'beta', clauses: [{ operator: 'inSegment' as const, segments: ['beta'] }] };

describe('evaluate', () => {
  const rs = ruleset(
    [
      booleanFlag('billing', {
        fallthrough: { variant: 'on' },
        rules: [
          {
            id: 'no-de',
            clauses: [{ attribute: 'country', operator: 'equals', values: ['de'] }],
            serve: { variant: 'off' },
          },
        ],
      }),
      booleanFlag('checkout', {
        prerequisites: [{ flag: 'billing', variant: 'on' }],
        rules: [
          { ...beta, serve: { variant: 'on' } },
          {
            id: 'half-of-pro',
            clauses: [{ attribute: 'plan', operator: 'equals', values: ['pro'] }],
            serve: {
              rollout: {
                variants: [
                  { variant: 'on', weight: 50_000 },
                  { variant: 'off', weight: 50_000 },
                ],
              },
            },
          },
        ],
      }),
      booleanFlag('killed', { enabled: false, fallthrough: { variant: 'on' } }),
      booleanFlag('split', {
        fallthrough: {
          rollout: {
            variants: [
              { variant: 'on', weight: ROLLOUT_TOTAL },
              { variant: 'off', weight: 0 },
            ],
          },
        },
      }),
    ],
    [segment('beta', { included: ['alice'], excluded: ['mallory'] })],
  );

  it('serves the off variant when the kill switch is off, whatever the rules say', () => {
    expect(evaluate(rs, 'killed', { key: 'alice' })).toEqual({
      reason: 'DISABLED',
      variant: 'off',
      value: false,
    });
  });

  it('serves the first matching rule with its id', () => {
    expect(evaluate(rs, 'checkout', { key: 'alice' })).toEqual({
      reason: 'TARGETING_MATCH',
      variant: 'on',
      value: true,
      ruleId: 'beta',
    });
  });

  it('buckets inside a rule that serves a rollout', () => {
    const results = new Set(
      ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8'].map((key) =>
        variantOf(evaluate(rs, 'checkout', { key, plan: 'pro' })),
      ),
    );
    expect(results).toEqual(new Set(['on', 'off']));
  });

  it('falls through to the default rule', () => {
    expect(evaluate(rs, 'checkout', { key: 'bob' })).toEqual({
      reason: 'DEFAULT',
      variant: 'off',
      value: false,
    });
    expect(evaluate(rs, 'split', { key: 'bob' })).toEqual({
      reason: 'SPLIT',
      variant: 'on',
      value: true,
    });
  });

  it('serves the off variant when a prerequisite is not met', () => {
    expect(evaluate(rs, 'checkout', { key: 'alice', country: 'de' })).toEqual({
      reason: 'PREREQUISITE_FAILED',
      variant: 'off',
      value: false,
    });
  });

  it('treats a disabled prerequisite as unmet even if its off variant matches', () => {
    const r = ruleset([
      booleanFlag('a', { enabled: false, offVariant: 'on' }),
      booleanFlag('b', {
        prerequisites: [{ flag: 'a', variant: 'on' }],
        fallthrough: { variant: 'on' },
      }),
    ]);
    expect(evaluate(r, 'b', { key: 'x' }).reason).toBe('PREREQUISITE_FAILED');
  });

  it('treats a missing prerequisite flag as unmet', () => {
    const r = ruleset([booleanFlag('b', { prerequisites: [{ flag: 'gone', variant: 'on' }] })]);
    expect(evaluate(r, 'b', { key: 'x' }).reason).toBe('PREREQUISITE_FAILED');
  });

  it('honours segment exclusion over inclusion', () => {
    expect(variantOf(evaluate(rs, 'checkout', { key: 'mallory' }))).toBe('off');
    const s = segment('s', {
      included: ['eve'],
      excluded: ['eve'],
      rules: [{ id: 'r', clauses: [{ attribute: 'plan', operator: 'equals', values: ['pro'] }] }],
    });
    expect(inSegment(s, { key: 'eve' })).toBe(false);
    expect(inSegment(s, { key: 'zed', plan: 'pro' })).toBe(true);
    expect(inSegment(s, { key: 'zed', plan: 'free' })).toBe(false);
  });

  it('supports negated segment clauses and ignores unknown segments', () => {
    const r = ruleset(
      [
        booleanFlag('f', {
          rules: [
            {
              id: 'not-beta',
              clauses: [{ operator: 'inSegment', segments: ['beta', 'ghost'], negate: true }],
              serve: { variant: 'on' },
            },
          ],
        }),
      ],
      [segment('beta', { included: ['alice'] })],
    );
    expect(variantOf(evaluate(r, 'f', { key: 'alice' }))).toBe('off');
    expect(variantOf(evaluate(r, 'f', { key: 'bob' }))).toBe('on');
  });

  it('returns errors instead of throwing', () => {
    expect(evaluate(rs, 'nope', { key: 'a' })).toMatchObject({
      reason: 'ERROR',
      errorCode: 'FLAG_NOT_FOUND',
    });
    for (const bad of [null, 'alice', [], {}, { key: '' }, { key: 7 }]) {
      expect(evaluate(rs, 'checkout', bad)).toMatchObject({ errorCode: 'INVALID_CONTEXT' });
    }
    const broken = ruleset([booleanFlag('f', { offVariant: 'gone', enabled: false })]);
    expect(evaluate(broken, 'f', { key: 'a' })).toMatchObject({ errorCode: 'MALFORMED_FLAG' });
  });

  it('detects prerequisite cycles in a ruleset that skipped validation', () => {
    const cyclic = ruleset([
      booleanFlag('a', { prerequisites: [{ flag: 'b', variant: 'on' }] }),
      booleanFlag('b', { prerequisites: [{ flag: 'a', variant: 'on' }] }),
    ]);
    expect(evaluate(cyclic, 'a', { key: 'x' })).toMatchObject({
      reason: 'ERROR',
      errorCode: 'PREREQUISITE_CYCLE',
    });
  });

  it('stops prerequisite chains deeper than the limit', () => {
    const chain = Array.from({ length: 12 }, (_, i) =>
      booleanFlag(`f${i}`, {
        fallthrough: { variant: 'on' },
        prerequisites: i === 11 ? [] : [{ flag: `f${i + 1}`, variant: 'on' }],
      }),
    );
    expect(evaluate(ruleset(chain), 'f0', { key: 'x' })).toMatchObject({
      errorCode: 'PREREQUISITE_CYCLE',
    });
    expect(variantOf(evaluate(ruleset(chain), 'f3', { key: 'x' }))).toBe('on');
  });
});

describe('evaluateAll', () => {
  it('evaluates only the flags the filter lets through', () => {
    const rs = ruleset([booleanFlag('a', { clientSide: true }), booleanFlag('b')]);
    expect(Object.keys(evaluateAll(rs, { key: 'x' }, (f) => f.clientSide))).toEqual(['a']);
    expect(Object.keys(evaluateAll(rs, { key: 'x' }))).toEqual(['a', 'b']);
  });
});

describe('prerequisite validation', () => {
  it('rejects two- and three-flag cycles with the cycle spelled out', () => {
    const two = ruleset([
      booleanFlag('a', { prerequisites: [{ flag: 'b', variant: 'on' }] }),
      booleanFlag('b', { prerequisites: [{ flag: 'a', variant: 'on' }] }),
    ]);
    const three = ruleset([
      booleanFlag('a', { prerequisites: [{ flag: 'b', variant: 'on' }] }),
      booleanFlag('b', { prerequisites: [{ flag: 'c', variant: 'on' }] }),
      booleanFlag('c', { prerequisites: [{ flag: 'a', variant: 'on' }] }),
    ]);
    const messages = (r: Ruleset) => {
      const v = validateRuleset(r);
      return v.ok ? [] : v.issues.map((i) => `${i.path}: ${i.message}`);
    };
    expect(messages(two)).toEqual([
      'flags.b.prerequisites: prerequisites form a cycle: a -> b -> a',
    ]);
    expect(messages(three)).toEqual([
      'flags.c.prerequisites: prerequisites form a cycle: a -> b -> c -> a',
    ]);
  });

  it('rejects chains longer than the depth limit and accepts diamonds', () => {
    const chain = (n: number) =>
      ruleset(
        Array.from({ length: n }, (_, i) =>
          booleanFlag(`f${i}`, {
            prerequisites: i === n - 1 ? [] : [{ flag: `f${i + 1}`, variant: 'on' }],
          }),
        ),
      );
    expect(validateRuleset(chain(10)).ok).toBe(true);
    const deep = validateRuleset(chain(11));
    expect(deep.ok ? [] : deep.issues).toEqual([
      { path: 'flags.f0.prerequisites', message: 'prerequisite chain is longer than 10 flags' },
    ]);
    const diamond = ruleset([
      booleanFlag('top', {
        prerequisites: [
          { flag: 'left', variant: 'on' },
          { flag: 'right', variant: 'on' },
        ],
      }),
      booleanFlag('left', { prerequisites: [{ flag: 'bottom', variant: 'on' }] }),
      booleanFlag('right', { prerequisites: [{ flag: 'bottom', variant: 'on' }] }),
      booleanFlag('bottom'),
    ]);
    expect(validateRuleset(diamond).ok).toBe(true);
  });
});

/**
 * A second, plain implementation of the evaluation semantics for the subset
 * the generators produce (x.y.z versions, simple patterns). It shares only the
 * bucketing function, which has its own tests.
 */
function reference(rs: Ruleset, key: string, ctx: Context): string {
  const flag = own(rs.flags, key);
  if (flag === undefined) throw new Error('generator produced a dangling key');
  if (!flag.enabled) return flag.offVariant;
  for (const p of flag.prerequisites) {
    const target = own(rs.flags, p.flag);
    if (target === undefined || !target.enabled || reference(rs, p.flag, ctx) !== p.variant) {
      return flag.offVariant;
    }
  }
  const serve = (s: Serve): string => {
    if ('variant' in s) return s.variant;
    const b = bucketOf(flag.salt, ctx.key);
    let acc = 0;
    for (const v of s.rollout.variants) {
      acc += v.weight;
      if (b < acc) return v.variant;
    }
    return s.rollout.variants[s.rollout.variants.length - 1]?.variant ?? '';
  };
  for (const rule of flag.rules) {
    if (rule.clauses.every((c) => referenceClause(rs, c, ctx))) return serve(rule.serve);
  }
  return serve(flag.fallthrough);
}

function referenceClause(rs: Ruleset, c: Clause, ctx: Context): boolean {
  if (c.operator === 'inSegment') {
    const hit = c.segments.some((k) => {
      const s = own(rs.segments, k);
      if (s === undefined) return false;
      if (s.excluded.includes(ctx.key)) return false;
      if (s.included.includes(ctx.key)) return true;
      return s.rules.some((r) => r.clauses.every((cl) => referenceClause(rs, cl, ctx)));
    });
    return c.negate === true ? !hit : hit;
  }
  return referenceAttribute(c, ctx);
}

function referenceAttribute(c: AttributeClause, ctx: Context): boolean {
  const raw = own(ctx, c.attribute);
  if (raw === undefined || raw === null) return false;
  const values = Array.isArray(raw) ? raw : [raw];
  const version = (s: string) => s.split('.').map(Number);
  const cmpVersion = (a: string, b: string) => {
    const [x, y] = [version(a), version(b)];
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
    return 0;
  };
  const one = (a: unknown, e: unknown): boolean => {
    const s = typeof a === 'string' && typeof e === 'string';
    const n = typeof a === 'number' && typeof e === 'number';
    switch (c.operator) {
      case 'equals':
      case 'in':
        return a === e;
      case 'contains':
        return s && a.indexOf(e) >= 0;
      case 'startsWith':
        return s && a.slice(0, e.length) === e;
      case 'endsWith':
        return s && a.slice(-e.length) === e;
      case 'matches':
        return s && new RegExp(e, 'u').test(a);
      case 'lt':
        return n && a < e;
      case 'lte':
        return n && a <= e;
      case 'gt':
        return n && a > e;
      case 'gte':
        return n && a >= e;
      case 'semverEq':
        return s && /^\d+\.\d+\.\d+$/.test(a) && cmpVersion(a, e) === 0;
      case 'semverLt':
        return s && /^\d+\.\d+\.\d+$/.test(a) && cmpVersion(a, e) < 0;
      case 'semverGt':
        return s && /^\d+\.\d+\.\d+$/.test(a) && cmpVersion(a, e) > 0;
    }
  };
  const hit = values.some((a) => c.values.some((e) => one(a, e)));
  return c.negate === true ? !hit : hit;
}

const contextArb: fc.Arbitrary<Context> = fc.record(
  {
    key: fc.constantFrom('alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'zed'),
    country: fc.constantFrom('us', 'de', 'jp', 'xx'),
    plan: fc.constantFrom('free', 'pro', 'acme'),
    age: fc.integer({ min: -1, max: 101 }),
    version: fc.tuple(fc.nat(3), fc.nat(3), fc.nat(3)).map(([a, b, c]) => `${a}.${b}.${c}`),
    email: fc.constantFrom('alice@acme.com', 'zed@example.org', 'test@acme.com'),
    groups: fc.uniqueArray(fc.constantFrom('beta', 'staff', 'acme'), { maxLength: 3 }),
  },
  { requiredKeys: ['key'] },
);

describe('evaluate against the reference model', () => {
  it('agrees on every flag of random valid rulesets', () => {
    fc.assert(
      fc.property(rulesetArb, fc.array(contextArb, { minLength: 1, maxLength: 5 }), (rs, ctxs) => {
        for (const ctx of ctxs) {
          for (const key of Object.keys(rs.flags)) {
            const got = evaluate(rs, key, ctx);
            expect(got.reason).not.toBe('ERROR');
            expect(variantOf(got)).toBe(reference(rs, key, ctx));
          }
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('serves the off variant to everyone when the kill switch is off', () => {
    fc.assert(
      fc.property(rulesetArb, contextArb, (rs, ctx) => {
        for (const flag of Object.values<Flag>(rs.flags)) {
          const off = { ...rs, flags: { ...rs.flags, [flag.key]: { ...flag, enabled: false } } };
          expect(evaluate(off, flag.key, ctx)).toMatchObject({
            reason: 'DISABLED',
            variant: flag.offVariant,
          });
        }
      }),
    );
  });
});
