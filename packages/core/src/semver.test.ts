import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compareSemver, parseSemver, type SemVer } from './semver.js';

const parse = (s: string): SemVer => {
  const v = parseSemver(s);
  if (v === undefined) throw new Error(`not semver: ${s}`);
  return v;
};
const cmp = (a: string, b: string) => compareSemver(parse(a), parse(b));

describe('parseSemver', () => {
  it('parses full versions, pre-release and build', () => {
    expect(parseSemver('1.2.3-beta.11+sha.5114f85')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: ['beta', 11],
    });
  });

  it('fills in missing minor and patch and accepts a leading v', () => {
    expect(parseSemver('2')).toEqual({ major: 2, minor: 0, patch: 0, prerelease: [] });
    expect(parseSemver('v2.1')).toEqual({ major: 2, minor: 1, patch: 0, prerelease: [] });
  });

  it.each(['', '1.', '01.2.3', '1.02.3', '1.2.3-', '1.2.3-01', '1.2.3+', 'x.y.z', '1.2.3.4'])(
    'rejects %j',
    (s) => {
      expect(parseSemver(s)).toBeUndefined();
    },
  );

  it('rejects numbers beyond the safe integer range and very long input', () => {
    expect(parseSemver('99999999999999999999.0.0')).toBeUndefined();
    expect(parseSemver('1.0.0-99999999999999999999')).toBeUndefined();
    expect(parseSemver(`1.0.0-${'a'.repeat(300)}`)).toBeUndefined();
  });
});

describe('compareSemver', () => {
  it('orders the example chain from the spec', () => {
    const chain = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
      '1.0.1',
      '1.1.0',
      '2.0.0',
    ];
    for (let i = 0; i < chain.length; i++) {
      for (let j = 0; j < chain.length; j++) {
        expect(Math.sign(cmp(chain[i] ?? '', chain[j] ?? ''))).toBe(Math.sign(i - j));
      }
    }
  });

  it('ignores build metadata', () => {
    expect(cmp('1.0.0+a', '1.0.0+b')).toBe(0);
  });

  const idArb = fc.oneof(fc.nat(20), fc.constantFrom('alpha', 'beta', 'rc', 'a1', '-x'));
  const versionArb = fc.record({
    major: fc.nat(5),
    minor: fc.nat(5),
    patch: fc.nat(5),
    prerelease: fc.array(idArb, { maxLength: 3 }),
  });
  const render = (v: SemVer) =>
    `${v.major}.${v.minor}.${v.patch}${v.prerelease.length > 0 ? `-${v.prerelease.join('.')}` : ''}`;

  it('is antisymmetric and transitive, and parse round-trips', () => {
    fc.assert(
      fc.property(versionArb, versionArb, versionArb, (a, b, c) => {
        expect(parseSemver(render(a))).toEqual(a);
        expect(compareSemver(a, b) + compareSemver(b, a)).toBe(0);
        if (compareSemver(a, b) <= 0 && compareSemver(b, c) <= 0) {
          expect(compareSemver(a, c)).toBeLessThanOrEqual(0);
        }
      }),
      { numRuns: 2000 },
    );
  });

  it('matches tuple ordering for release versions', () => {
    fc.assert(
      fc.property(versionArb, versionArb, (a, b) => {
        const ta = [a.major, a.minor, a.patch];
        const tb = [b.major, b.minor, b.patch];
        const i = ta.findIndex((x, k) => x !== tb[k]);
        const expected = i === -1 ? 0 : Math.sign((ta[i] ?? 0) - (tb[i] ?? 0));
        const ra = { ...a, prerelease: [] };
        const rb = { ...b, prerelease: [] };
        expect(compareSemver(ra, rb)).toBe(expected);
      }),
    );
  });
});
