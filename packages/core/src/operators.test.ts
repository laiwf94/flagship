import { describe, expect, it } from 'vitest';
import { booleanFlag, segment } from '../test/fixtures.js';
import type { AttributeClause, AttributeOperator, ClauseValue, Context } from './model.js';
import { clauseValueProblems, matchAttributeClause } from './operators.js';
import { validateFlag, validateSegment } from './validate.js';

const ctx: Context = {
  key: 'alice',
  email: 'alice@acme.com',
  country: 'de',
  age: 34,
  beta: true,
  version: '2.4.1',
  groups: ['staff', 'beta'],
  nothing: null,
};

const clause = (
  attribute: string,
  operator: AttributeOperator,
  values: ClauseValue[],
  negate?: boolean,
): AttributeClause =>
  negate === undefined ? { attribute, operator, values } : { attribute, operator, values, negate };

describe('matchAttributeClause', () => {
  it.each<[AttributeClause, boolean]>([
    [clause('key', 'equals', ['alice']), true],
    [clause('country', 'equals', ['us']), false],
    [clause('country', 'in', ['us', 'de']), true],
    [clause('age', 'in', [34]), true],
    [clause('age', 'in', ['34']), false],
    [clause('beta', 'equals', [true]), true],
    [clause('email', 'contains', ['@acme']), true],
    [clause('email', 'startsWith', ['bob']), false],
    [clause('email', 'endsWith', ['.com']), true],
    [clause('email', 'matches', ['^[a-z]+@acme\\.com$']), true],
    [clause('email', 'matches', ['^bob']), false],
    [clause('age', 'lt', [34]), false],
    [clause('age', 'lte', [34]), true],
    [clause('age', 'gt', [18]), true],
    [clause('age', 'gte', [35]), false],
    [clause('version', 'semverEq', ['2.4.1']), true],
    [clause('version', 'semverLt', ['2.10.0']), true],
    [clause('version', 'semverGt', ['2.4.1-rc.1']), true],
    [clause('groups', 'in', ['beta']), true],
    [clause('groups', 'equals', ['admin']), false],
    [clause('country', 'in', ['us'], true), true],
    [clause('country', 'in', ['de'], true), false],
  ])('%j -> %s', (c, expected) => {
    expect(matchAttributeClause(c, ctx)).toBe(expected);
  });

  it('treats type mismatches as no match instead of coercing', () => {
    expect(matchAttributeClause(clause('country', 'lt', [5]), ctx)).toBe(false);
    expect(matchAttributeClause(clause('age', 'contains', ['3']), ctx)).toBe(false);
    expect(matchAttributeClause(clause('age', 'startsWith', ['3']), ctx)).toBe(false);
    expect(matchAttributeClause(clause('age', 'endsWith', ['4']), ctx)).toBe(false);
    expect(matchAttributeClause(clause('age', 'matches', ['3']), ctx)).toBe(false);
    expect(matchAttributeClause(clause('age', 'semverEq', ['1.0.0']), ctx)).toBe(false);
    expect(matchAttributeClause(clause('country', 'semverEq', ['1.0.0']), ctx)).toBe(false);
    expect(matchAttributeClause(clause('version', 'semverEq', ['nope']), ctx)).toBe(false);
  });

  it('never matches a missing or null attribute, even when negated', () => {
    expect(matchAttributeClause(clause('plan', 'in', ['pro']), ctx)).toBe(false);
    expect(matchAttributeClause(clause('plan', 'in', ['pro'], true), ctx)).toBe(false);
    expect(matchAttributeClause(clause('nothing', 'in', ['x'], true), ctx)).toBe(false);
    expect(matchAttributeClause(clause('constructor', 'in', ['x'], true), ctx)).toBe(false);
  });
});

describe('clauseValueProblems', () => {
  it.each<[AttributeClause, string[]]>([
    [clause('a', 'equals', ['x', 'y']), ['"equals" takes exactly one value']],
    [clause('a', 'in', ['x', 'y', 3]), []],
    [
      clause('a', 'contains', ['', 3]),
      ['0: must be a non-empty string', '1: must be a non-empty string'],
    ],
    [clause('a', 'matches', [5]), ['0: must be a pattern string']],
    [
      clause('a', 'matches', ['(a+)\\1']),
      ['0: invalid pattern: backreferences are not supported at position 4'],
    ],
    [clause('a', 'lt', ['5']), ['0: must be a number']],
    [clause('a', 'gte', [1, 2]), ['"gte" takes exactly one value']],
    [clause('a', 'semverLt', ['two']), ['0: must be a semantic version such as 2.4.0']],
    [clause('a', 'semverGt', ['2.0.0']), []],
  ])('%j', (c, expected) => {
    expect(clauseValueProblems(c).map(([i, m]) => (i === undefined ? m : `${i}: ${m}`))).toEqual(
      expected,
    );
  });

  it('is applied to flag rules and segment rules with paths', () => {
    const flag = validateFlag(
      booleanFlag('f', {
        rules: [
          {
            id: 'r',
            clauses: [
              { operator: 'inSegment', segments: ['s'] },
              clause('email', 'matches', ['(a+']),
            ],
            serve: { variant: 'on' },
          },
        ],
      }),
    );
    expect(flag.ok ? [] : flag.issues).toEqual([
      {
        path: 'rules[0].clauses[1].values[0]',
        message: 'invalid pattern: missing ")" at position 0',
      },
    ]);
    const seg = validateSegment(
      segment('s', { rules: [{ id: 'r', clauses: [clause('age', 'lt', [1, 2])] }] }),
    );
    expect(seg.ok ? [] : seg.issues).toEqual([
      { path: 'rules[0].clauses[0].values', message: '"lt" takes exactly one value' },
    ]);
  });
});
