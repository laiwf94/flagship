import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { rulesetArb } from '../test/arbitraries.js';
import { booleanFlag, ruleset, segment } from '../test/fixtures.js';
import { bucketOf } from './bucket.js';
import { evaluate, explain } from './evaluate.js';
import { ROLLOUT_TOTAL, type Context, type Ruleset } from './model.js';

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

describe('explain', () => {
  it('returns exactly what evaluate returns, on random valid rulesets', () => {
    fc.assert(
      fc.property(rulesetArb, fc.array(contextArb, { minLength: 1, maxLength: 4 }), (rs, ctxs) => {
        for (const ctx of ctxs) {
          for (const key of Object.keys(rs.flags)) {
            expect(explain(rs, key, ctx).evaluation).toEqual(evaluate(rs, key, ctx));
          }
        }
      }),
      { numRuns: 500 },
    );
  });

  it('returns exactly what evaluate returns on every conformance case', () => {
    const dir = join(import.meta.dirname, '..', '..', 'conformance', 'cases');
    let checked = 0;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const c = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
        ruleset: Ruleset;
        tests?: { flag: string; context: unknown }[];
      };
      for (const t of c.tests ?? []) {
        expect(explain(c.ruleset, t.flag, t.context).evaluation).toEqual(
          evaluate(c.ruleset, t.flag, t.context),
        );
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  const rs = ruleset(
    [
      booleanFlag('billing', { fallthrough: { variant: 'on' } }),
      booleanFlag('killed', { enabled: false, fallthrough: { variant: 'on' } }),
      booleanFlag('checkout', {
        prerequisites: [{ flag: 'billing', variant: 'on' }],
        rules: [
          {
            id: 'germany-pro',
            description: 'Pro customers in Germany',
            clauses: [
              { attribute: 'country', operator: 'equals', values: ['de'] },
              { attribute: 'plan', operator: 'equals', values: ['pro'] },
            ],
            serve: { variant: 'on' },
          },
          {
            id: 'beta',
            clauses: [{ operator: 'inSegment', segments: ['ghost', 'beta'] }],
            serve: {
              rollout: {
                bucketBy: 'org',
                variants: [
                  { variant: 'on', weight: ROLLOUT_TOTAL },
                  { variant: 'off', weight: 0 },
                ],
              },
            },
          },
        ],
        fallthrough: {
          rollout: {
            variants: [
              { variant: 'on', weight: 0 },
              { variant: 'off', weight: ROLLOUT_TOTAL },
            ],
          },
        },
      }),
      booleanFlag('needs-killed', { prerequisites: [{ flag: 'killed', variant: 'off' }] }),
      booleanFlag('needs-missing', { prerequisites: [{ flag: 'gone', variant: 'on' }] }),
      booleanFlag('self', { prerequisites: [{ flag: 'self', variant: 'on' }] }),
      booleanFlag('broken-child', {
        enabled: true,
        offVariant: 'nope',
        fallthrough: { variant: 'nope' },
      }),
      booleanFlag('needs-broken', { prerequisites: [{ flag: 'broken-child', variant: 'on' }] }),
    ],
    [segment('beta', { included: ['bob'] })],
  );

  it('records every clause of a rule that failed, and stops at the first match', () => {
    const got = explain(rs, 'checkout', { key: 'bob', country: 'us', plan: 'pro', org: 'acme' });
    expect(got.evaluation).toEqual({
      reason: 'TARGETING_MATCH',
      variant: 'on',
      value: true,
      ruleId: 'beta',
    });
    expect(got.trace).toEqual([
      { step: 'killSwitch', enabled: true },
      {
        step: 'prerequisite',
        flag: 'billing',
        expected: 'on',
        actual: 'on',
        enabled: true,
        passed: true,
      },
      {
        step: 'rule',
        index: 0,
        id: 'germany-pro',
        description: 'Pro customers in Germany',
        matched: false,
        clauses: [
          { clause: expect.objectContaining({ attribute: 'country' }), matched: false },
          { clause: expect.objectContaining({ attribute: 'plan' }), matched: true },
        ],
      },
      {
        step: 'rule',
        index: 1,
        id: 'beta',
        matched: true,
        clauses: [
          {
            clause: expect.objectContaining({ operator: 'inSegment' }),
            matched: true,
            segments: [
              { key: 'ghost', found: false, matched: false },
              { key: 'beta', found: true, matched: true },
            ],
          },
        ],
        bucket: { bucketBy: 'org', value: 'acme', bucket: bucketOf('checkout', 'acme') },
      },
    ]);
  });

  it('shows the default rule and its bucket when no rule matches', () => {
    const got = explain(rs, 'checkout', { key: 'carol' });
    expect(got.evaluation).toMatchObject({ reason: 'SPLIT', variant: 'off' });
    expect(got.trace.map((s) => s.step)).toEqual([
      'killSwitch',
      'prerequisite',
      'rule',
      'rule',
      'fallthrough',
    ]);
    expect(got.trace.at(-1)).toEqual({
      step: 'fallthrough',
      bucket: { bucketBy: 'key', value: 'carol', bucket: bucketOf('checkout', 'carol') },
    });
    expect(explain(rs, 'billing', { key: 'carol' }).trace.at(-1)).toEqual({
      step: 'fallthrough',
    });
  });

  it('stops at the kill switch and at failed prerequisites', () => {
    expect(explain(rs, 'killed', { key: 'a' })).toEqual({
      evaluation: { reason: 'DISABLED', variant: 'off', value: false },
      trace: [{ step: 'killSwitch', enabled: false }],
    });
    // The prerequisite serves "off", as expected, but it is switched off, so it fails.
    expect(explain(rs, 'needs-killed', { key: 'a' }).trace.at(-1)).toEqual({
      step: 'prerequisite',
      flag: 'killed',
      expected: 'off',
      actual: 'off',
      enabled: false,
      passed: false,
    });
    const missing = explain(rs, 'needs-missing', { key: 'a' });
    expect(missing.evaluation).toMatchObject({ reason: 'PREREQUISITE_FAILED' });
    expect(missing.trace.at(-1)).toMatchObject({ flag: 'gone', actual: null, passed: false });
  });

  it('reports errors the way evaluate does', () => {
    expect(explain(rs, 'nope', { key: 'a' })).toEqual({
      evaluation: { reason: 'ERROR', errorCode: 'FLAG_NOT_FOUND', message: 'no flag "nope"' },
      trace: [],
    });
    expect(explain(rs, 'billing', { key: '' }).evaluation).toMatchObject({
      errorCode: 'INVALID_CONTEXT',
    });
    expect(explain(rs, 'self', { key: 'a' }).evaluation).toMatchObject({
      errorCode: 'PREREQUISITE_CYCLE',
    });
    const broken = explain(rs, 'needs-broken', { key: 'a' });
    expect(broken.evaluation).toEqual(evaluate(rs, 'needs-broken', { key: 'a' }));
    expect(broken.evaluation).toMatchObject({ errorCode: 'MALFORMED_FLAG' });
    expect(broken.trace.at(-1)).toMatchObject({ step: 'prerequisite', actual: null });
  });
});
