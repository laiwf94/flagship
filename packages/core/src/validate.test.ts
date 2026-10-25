import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { rulesetArb } from '../test/arbitraries.js';
import { booleanFlag, ruleset, segment } from '../test/fixtures.js';
import { LIMITS, own, type Flag } from './model.js';
import { formatPath, validateFlag, validateRuleset, validateSegment } from './validate.js';

function issuesOf(result: ReturnType<typeof validateRuleset>): string[] {
  return result.ok ? [] : result.issues.map((i) => `${i.path}: ${i.message}`);
}

describe('formatPath', () => {
  it('joins names with dots and indexes with brackets', () => {
    expect(formatPath(['flags', 'checkout', 'rules', 2, 'clauses', 0])).toBe(
      'flags.checkout.rules[2].clauses[0]',
    );
    expect(formatPath([0, 'value'])).toBe('[0].value');
  });
});

describe('validateFlag', () => {
  it('accepts a minimal boolean flag', () => {
    expect(validateFlag(booleanFlag('checkout'))).toEqual({
      ok: true,
      value: booleanFlag('checkout'),
    });
  });

  it.each<[string, Partial<Flag> | Record<string, unknown>, string]>([
    ['bad key', { key: '-x' }, 'key: must start with a letter or digit'],
    ['prototype key', { key: '__proto__' }, 'key: must start with a letter or digit'],
    ['unknown field', { owner: 'alice' }, 'Unrecognized key'],
    [
      'boolean value type',
      {
        variants: [
          { key: 'on', value: 'yes' },
          { key: 'off', value: false },
        ],
      },
      'variants[0].value: must be true or false',
    ],
    [
      'boolean needs true and false',
      {
        variants: [
          { key: 'on', value: true },
          { key: 'off', value: true },
        ],
      },
      'variants: a boolean flag has exactly two variants',
    ],
    [
      'duplicate variant keys',
      {
        type: 'string',
        variants: [
          { key: 'a', value: 'x' },
          { key: 'a', value: 'y' },
        ],
        offVariant: 'a',
        fallthrough: { variant: 'a' },
      },
      'variants: duplicate variant key "a"',
    ],
    ['unknown off variant', { offVariant: 'nope' }, 'offVariant: unknown variant "nope"'],
    [
      'unknown fallthrough variant',
      { fallthrough: { variant: 'nope' } },
      'fallthrough.variant: unknown variant "nope"',
    ],
    [
      'weights must sum to 100%',
      {
        fallthrough: {
          rollout: {
            variants: [
              { variant: 'on', weight: 10_000 },
              { variant: 'off', weight: 10_000 },
            ],
          },
        },
      },
      'fallthrough.rollout.variants: weights must add up to 100000',
    ],
    [
      'unknown rollout variant',
      {
        fallthrough: {
          rollout: {
            variants: [
              { variant: 'on', weight: 50_000 },
              { variant: 'maybe', weight: 50_000 },
            ],
          },
        },
      },
      'fallthrough.rollout.variants[1].variant: unknown variant "maybe"',
    ],
    [
      'repeated rollout variant',
      {
        fallthrough: {
          rollout: {
            variants: [
              { variant: 'on', weight: 50_000 },
              { variant: 'on', weight: 50_000 },
            ],
          },
        },
      },
      'fallthrough.rollout.variants: variant "on" appears more than once',
    ],
    [
      'duplicate rule ids',
      {
        rules: [
          {
            id: 'r',
            clauses: [{ attribute: 'plan', operator: 'equals', values: ['pro'] }],
            serve: { variant: 'on' },
          },
          {
            id: 'r',
            clauses: [{ attribute: 'plan', operator: 'equals', values: ['free'] }],
            serve: { variant: 'off' },
          },
        ],
      },
      'rules: duplicate rule id "r"',
    ],
    [
      'rule with no clauses',
      { rules: [{ id: 'r', clauses: [], serve: { variant: 'on' } }] },
      'rules[0].clauses',
    ],
    [
      'self prerequisite',
      { prerequisites: [{ flag: 'checkout', variant: 'on' }] },
      'prerequisites[0].flag: a flag cannot be its own prerequisite',
    ],
    [
      'repeated prerequisite',
      {
        prerequisites: [
          { flag: 'billing', variant: 'on' },
          { flag: 'billing', variant: 'off' },
        ],
      },
      'prerequisites: prerequisite "billing" is listed more than once',
    ],
  ])('rejects %s', (_name, overrides, expected) => {
    const result = validateFlag({ ...booleanFlag('checkout'), ...overrides });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => `${i.path}: ${i.message}`).join('\n')).toContain(expected);
    }
  });

  it('checks value types for string, number and json flags', () => {
    const base = {
      ...booleanFlag('f'),
      offVariant: 'a',
      fallthrough: { variant: 'a' },
    };
    const bad = (type: Flag['type'], value: unknown) =>
      validateFlag({
        ...base,
        type,
        variants: [
          { key: 'a', value },
          { key: 'b', value },
        ],
      });
    expect(bad('number', 'one').ok).toBe(false);
    expect(bad('number', 1).ok).toBe(true);
    expect(bad('string', 7).ok).toBe(false);
    expect(bad('string', 'x'.repeat(LIMITS.stringValueLength + 1)).ok).toBe(false);
    expect(bad('string', 'fine').ok).toBe(true);
    expect(bad('json', { big: 'x'.repeat(LIMITS.jsonValueBytes) }).ok).toBe(false);
    expect(bad('json', { theme: 'dark', sizes: [1, 2] }).ok).toBe(true);
  });
});

describe('validateSegment', () => {
  it('accepts a segment and rejects duplicate rule ids', () => {
    expect(validateSegment(segment('beta', { included: ['alice'] })).ok).toBe(true);
    const rule = { id: 'x', clauses: [{ attribute: 'plan', operator: 'equals', values: ['pro'] }] };
    const result = validateSegment(segment('beta', { rules: [rule, rule] as never }));
    expect(result.ok).toBe(false);
    expect(validateSegment({ key: 'beta' }).ok).toBe(false);
  });

  it('does not allow segments inside segment rules', () => {
    const result = validateSegment(
      segment('beta', {
        rules: [{ id: 'x', clauses: [{ operator: 'inSegment', segments: ['other'] }] }] as never,
      }),
    );
    expect(result.ok).toBe(false);
  });
});

describe('validateRuleset', () => {
  it('accepts flags that reference existing segments and flags', () => {
    const rs = ruleset(
      [
        booleanFlag('billing'),
        booleanFlag('checkout', {
          prerequisites: [{ flag: 'billing', variant: 'on' }],
          rules: [
            {
              id: 'beta',
              clauses: [{ operator: 'inSegment', segments: ['beta'] }],
              serve: { variant: 'on' },
            },
          ],
        }),
      ],
      [segment('beta')],
    );
    expect(issuesOf(validateRuleset(rs))).toEqual([]);
  });

  it('reports unknown segments, unknown prerequisite flags and variants with full paths', () => {
    const rs = ruleset([
      booleanFlag('a', {
        prerequisites: [
          { flag: 'ghost', variant: 'on' },
          { flag: 'b', variant: 'maybe' },
        ],
        rules: [
          {
            id: 'r',
            clauses: [{ operator: 'inSegment', segments: ['missing'] }],
            serve: { variant: 'on' },
          },
        ],
      }),
      booleanFlag('b'),
    ]);
    expect(issuesOf(validateRuleset(rs))).toEqual([
      'flags.a.rules[0].clauses[0].segments[0]: unknown segment "missing"',
      'flags.a.prerequisites[0].flag: unknown flag "ghost"',
      'flags.a.prerequisites[1].variant: flag "b" has no variant "maybe"',
    ]);
  });

  it('prefixes per-flag and per-segment issues with their location', () => {
    const rule = { id: 'x', clauses: [{ attribute: 'plan', operator: 'equals', values: ['pro'] }] };
    const rs = ruleset(
      [booleanFlag('a', { offVariant: 'nope' })],
      [segment('s', { rules: [rule, rule] as never })],
    );
    expect(issuesOf(validateRuleset(rs))).toEqual([
      'segments.s.rules: duplicate rule id "x"',
      'flags.a.offVariant: unknown variant "nope"',
    ]);
  });

  it('requires map keys to match the item keys', () => {
    const rs = ruleset([booleanFlag('a')], [segment('s')]);
    const flag = own(rs.flags, 'a');
    const seg = own(rs.segments, 's');
    if (flag === undefined || seg === undefined) throw new Error('fixture');
    const moved = { ...rs, flags: { b: flag }, segments: { t: seg } };
    expect(issuesOf(validateRuleset(moved))).toEqual([
      'segments.t.key: must equal its map key "t"',
      'flags.b.key: must equal its map key "b"',
    ]);
  });

  it('rejects shape errors before cross checks', () => {
    expect(issuesOf(validateRuleset({ environment: 'p', version: -1, flags: {}, segments: {} })))
      .toMatchInlineSnapshot(`
        [
          "version: Too small: expected number to be >=0",
        ]
      `);
    expect(validateRuleset(null).ok).toBe(false);
  });

  it('enforces flag and segment counts', () => {
    const many = Array.from({ length: LIMITS.flagsPerRuleset + 1 }, (_, i) => booleanFlag(`f${i}`));
    const segs = Array.from({ length: LIMITS.segmentsPerRuleset + 1 }, (_, i) => segment(`s${i}`));
    const issues = issuesOf(validateRuleset(ruleset(many, segs)));
    expect(issues).toContain(`flags: at most ${LIMITS.flagsPerRuleset} flags per environment`);
    expect(issues).toContain(
      `segments: at most ${LIMITS.segmentsPerRuleset} segments per environment`,
    );
  });

  it('accepts every generated ruleset and survives a JSON round trip', () => {
    fc.assert(
      fc.property(rulesetArb, (rs) => {
        const result = validateRuleset(rs);
        expect(issuesOf(result)).toEqual([]);
        const again = validateRuleset(JSON.parse(JSON.stringify(rs)));
        expect(again).toEqual(result);
      }),
      { numRuns: 300 },
    );
  });
});

describe('own', () => {
  it('ignores inherited properties', () => {
    const record: Record<string, number> = { a: 1 };
    expect(own(record, 'a')).toBe(1);
    expect(own(record, 'constructor')).toBeUndefined();
    expect(own(record, 'toString')).toBeUndefined();
  });
});
