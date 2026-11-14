import { describe, expect, it } from 'vitest';
import { expectClose } from '../test/close.js';
import { betaI, gammaP, gammaQ, logGamma } from './special.js';

// Reference values agree with Abramowitz & Stegun tables 6.1, 6.5 and 26.5
// and, to the digits shown, with SciPy 1.17 (gammaln, gammainc, betainc).

describe('logGamma', () => {
  it.each([
    [0.1, 2.2527126517342055],
    [0.5, 0.5723649429247004], // ln √π
    [1, 0],
    [1.5, -0.12078223763524543],
    [2, 0],
    [3.7, 1.4280723266653883],
    [10, 12.801827480081467], // ln 9!
    [100, 359.1342053695754],
    [1e6, 12815504.569147611],
  ])('ln Γ(%d)', (x, expected) => {
    expectClose(logGamma(x), expected, 1e-13);
  });

  it('refuses x <= 0 and non-finite x', () => {
    expect(() => logGamma(0)).toThrow(RangeError);
    expect(() => logGamma(-1.5)).toThrow(RangeError);
    expect(() => logGamma(Infinity)).toThrow(RangeError);
    expect(() => logGamma(NaN)).toThrow(RangeError);
  });
});

describe('incomplete gamma', () => {
  it.each([
    [0.5, 0.1, 0.34527915398142317, 0.6547208460185768],
    [1, 1, 0.6321205588285577, 0.36787944117144245], // 1 − 1/e
    [2.5, 4, 0.8437643724222779, 0.1562356275777222],
    [10, 3, 0.0011024881301154815, 0.9988975118698845],
    [10, 25, 0.9997785233617512, 0.0002214766382487835],
    [100, 90, 0.15822098918643007, 0.84177901081357],
  ])('P(%d, %d) and Q', (a, x, p, q) => {
    expectClose(gammaP(a, x), p, 1e-13);
    expectClose(gammaQ(a, x), q, 1e-13);
  });

  it('keeps relative accuracy far into the upper tail', () => {
    expectClose(gammaQ(0.5, 40), 3.744097384202887e-19, 1e-12);
    expect(gammaP(0.5, 40)).toBe(1);
  });

  it('handles the ends of the range', () => {
    expect(gammaP(3, 0)).toBe(0);
    expect(gammaQ(3, 0)).toBe(1);
    expect(gammaP(3, Infinity)).toBe(1);
    expect(gammaQ(3, Infinity)).toBe(0);
  });

  it('refuses bad arguments', () => {
    expect(() => gammaP(0, 1)).toThrow(RangeError);
    expect(() => gammaQ(1, -1)).toThrow(RangeError);
    expect(() => gammaP(1, NaN)).toThrow(RangeError);
  });
});

describe('betaI', () => {
  it.each([
    [0.5, 0.5, 0.2, 0.2951672353008665], // (2/π)·asin(√0.2)
    [2, 3, 0.4, 0.5248],
    [5, 0.5, 0.9, 0.3166429150200122],
    [10, 10, 0.5, 0.5],
    [1, 1, 0.3, 0.3],
    [50, 0.5, 0.99, 0.3173043978741973],
  ])('I_x(%d, %d) at %d', (a, b, x, expected) => {
    expectClose(betaI(a, b, x), expected, 1e-13);
  });

  it('handles the ends and takes an exact complement', () => {
    expect(betaI(2, 3, 0)).toBe(0);
    expect(betaI(2, 3, 1)).toBe(1);
    expect(betaI(2, 3, 1, 0)).toBe(1);
    expectClose(betaI(2, 3, 0.6, 0.4), betaI(2, 3, 0.6), 1e-15);
  });

  it('refuses bad arguments', () => {
    expect(() => betaI(0, 1, 0.5)).toThrow(RangeError);
    expect(() => betaI(1, -1, 0.5)).toThrow(RangeError);
    expect(() => betaI(1, 1, 1.5)).toThrow(RangeError);
    expect(() => betaI(1, 1, 0.5, -0.1)).toThrow(RangeError);
    expect(() => betaI(Infinity, 1, 0.5)).toThrow(RangeError);
  });
});
