import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { LIMITS } from './model.js';
import { compilePattern, matchesPattern, patternProblem, search } from './regex.js';

const test = (p: string, s: string) => search(compilePattern(p), s);

describe('search', () => {
  it.each([
    ['abc', 'xxabcxx', true],
    ['^abc', 'xabc', false],
    ['abc$', 'abcx', false],
    ['^$', '', true],
    ['', 'anything', true],
    ['a|b', 'b', true],
    ['^(?:ab|cd)+$', 'abcdab', true],
    ['^(?:ab|cd)+$', 'abca', false],
    ['^a{2,3}$', 'aaaa', false],
    ['^a{2,3}$', 'aaa', true],
    ['^a{2}$', 'aa', true],
    ['^a{2,}$', 'aaaaaa', true],
    ['^a{2,}$', 'a', false],
    ['^colou?r$', 'color', true],
    ['^\\d+\\.\\d+$', '12.5', true],
    ['^\\w+@acme\\.com$', 'alice_1@acme.com', true],
    ['^\\w+@acme\\.com$', 'alice@acme.co', false],
    ['^[a-c]+$', 'abcabc', true],
    ['^[^a-c]+$', 'xyz', true],
    ['^[^a-c]+$', 'xaz', false],
    ['^[a\\-z]$', '-', true],
    ['^[az-]$', '-', true],
    ['^[\\d.]+$', '1.2.3', true],
    ['^\\S\\s\\S$', 'a b', true],
    ['^\\D\\W$', 'a!', true],
    ['^.$', '\n', false],
    ['^.$', '😀', true],
    ['^\\t\\n\\r$', '\t\n\r', true],
    ['^[\\t]$', '\t', true],
    ['^(a*)*$', 'aaaa', true],
    ['^()b$', 'b', true],
    ['^a*?b$', 'aab', true],
    ['a^b', 'a^b', false],
  ])('%s on %j is %s', (pattern, input, expected) => {
    expect(test(pattern, input)).toBe(expected);
  });

  it('runs catastrophic backtracking patterns in linear time', () => {
    const evil = 'a'.repeat(LIMITS.regexInputLength - 1) + '!';
    const started = performance.now();
    for (const p of ['^(a+)+$', '^(a|a)*$', '^(a|aa)+$', '^\\w*\\w*\\w*\\w*\\w*$', '^(.*a){20}$']) {
      expect(test(p, evil)).toBe(false);
    }
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('never matches inputs over the length limit', () => {
    expect(test('a', 'a'.repeat(LIMITS.regexInputLength))).toBe(true);
    expect(test('a', 'a'.repeat(LIMITS.regexInputLength + 1))).toBe(false);
  });
});

describe('compilePattern', () => {
  it.each([
    ['(a', 'missing ")" at position 0'],
    ['a)', 'unmatched ")" at position 1'],
    ['*a', 'nothing to repeat at position 0'],
    ['^*', 'nothing to repeat at position 0'],
    ['a**', 'quantifier after quantifier at position 2'],
    ['a{3,1}', 'repeat range is backwards at position 1'],
    ['a{101}', 'repeat counts are limited to 100 at position 1'],
    ['a{,3}', 'expected a number at position 2'],
    ['a{2', 'expected "}" at position 3'],
    ['a{99999999}', 'number too large at position 2'],
    ['(a)\\1', 'backreferences are not supported at position 3'],
    ['(?=a)', 'lookaround and named groups are not supported at position 0'],
    ['(?<n>a)', 'lookaround and named groups are not supported at position 0'],
    ['\\b', 'unsupported escape "\\b" at position 0'],
    ['[\\b]', 'unsupported escape "\\b" at position 1'],
    ['a\\', 'pattern ends with "\\" at position 1'],
    ['[abc', 'missing "]" at position 0'],
    ['[a', 'missing "]" at position 0'],
    ['[]', 'empty character class at position 0'],
    ['[z-a]', 'range out of order at position 3'],
    ['[\\d-z]', 'a range needs single characters at both ends at position 4'],
    [']', 'unescaped "]" at position 0'],
    ['}', 'unescaped "}" at position 0'],
    ['((((((((((a{100}){100}){100}){100}){100}){100}){100}){100}){100}){100})', 'too complex'],
    ['a'.repeat(LIMITS.regexPatternLength + 1), 'patterns are limited to 256 characters'],
  ])('rejects %j', (pattern, message) => {
    expect(patternProblem(pattern)).toContain(message);
  });

  it('accepts what it documents', () => {
    expect(patternProblem('^[a-z0-9._%+-]+@acme\\.(?:com|io)$')).toBeUndefined();
    expect(patternProblem('^[\\[\\]\\\\]$')).toBeUndefined();
  });
});

describe('matchesPattern', () => {
  it('caches compiled patterns and treats invalid ones as no match', () => {
    expect(matchesPattern('^beta-', 'beta-1')).toBe(true);
    expect(matchesPattern('^beta-', 'beta-1')).toBe(true);
    expect(matchesPattern('(', '(')).toBe(false);
    for (let i = 0; i < 1100; i++) matchesPattern(`^x${i}$`, `x${i}`);
    expect(matchesPattern('^x5$', 'x5')).toBe(true);
  });
});

// Random patterns from the supported subset, rendered as text; JavaScript's
// own RegExp (with the u flag) is the reference.
const atom: fc.Arbitrary<string> = fc.constantFrom(
  'a',
  'b',
  '.',
  '\\d',
  '\\w',
  '\\s',
  '[ab]',
  '[^a]',
  '[a-c]',
  '\\.',
  '1',
  ' ',
);
const patternArb: fc.Arbitrary<string> = fc.letrec<{ node: string }>((tie) => ({
  node: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    atom,
    fc.tuple(tie('node'), tie('node')).map(([a, b]) => a + b),
    fc.tuple(tie('node'), tie('node')).map(([a, b]) => `(?:${a}|${b})`),
    fc
      .tuple(tie('node'), fc.constantFrom('*', '+', '?', '{2}', '{1,3}', '{0,}', '*?'))
      .map(([a, q]) => `(?:${a})${q}`),
  ),
})).node;
const anchored = fc
  .tuple(fc.boolean(), patternArb, fc.boolean())
  .map(([s, p, e]) => `${s ? '^' : ''}${p}${e ? '$' : ''}`);

describe('agrees with RegExp on the supported subset', () => {
  it('for random patterns and inputs', () => {
    fc.assert(
      fc.property(
        anchored,
        fc.string({ unit: fc.constantFrom('a', 'b', 'c', '1', ' ', '.', '\n'), maxLength: 12 }),
        (pattern, input) => {
          expect(test(pattern, input)).toBe(new RegExp(pattern, 'u').test(input));
        },
      ),
      { numRuns: 5000 },
    );
  });
});
