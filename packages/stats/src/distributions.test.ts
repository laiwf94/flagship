import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { expectClose } from '../test/close.js';
import {
  chiSquareCdf,
  chiSquarePdf,
  chiSquareQuantile,
  chiSquareSf,
  normalCdf,
  normalPdf,
  normalQuantile,
  normalSf,
  studentTCdf,
  studentTPdf,
  studentTQuantile,
  studentTSf,
} from './distributions.js';

// Critical values are the ones printed in standard tables (normal: A&S 26.2;
// chi-square: A&S 26.8 and NIST/SEMATECH 1.3.6.7.4; t: NIST 1.3.6.7.2), given
// here to full double precision as SciPy 1.17 computes them.

describe('normal', () => {
  it.each([
    [-8, 6.22096057427174e-16],
    [-5, 2.866515718791933e-7],
    [-3, 0.0013498980316300933],
    [-1.96, 0.024997895148220435],
    [-1, 0.15865525393145707],
    [0, 0.5],
    [0.5, 0.6914624612740131],
    [1, 0.8413447460685429],
    [1.645, 0.9500150944608786],
    [1.96, 0.9750021048517795],
    [2.576, 0.995002467684265],
    [3, 0.9986501019683699],
    [5, 0.9999997133484281],
  ])('Φ(%d)', (x, expected) => {
    expectClose(normalCdf(x), expected, 1e-13);
  });

  it.each([
    [8, 6.22096057427174e-16],
    [10, 7.61985302416047e-24],
    [20, 2.7536241186061556e-89],
    [37, 5.7255712225239266e-300],
  ])('upper tail at %d keeps relative accuracy', (x, expected) => {
    expectClose(normalSf(x), expected, 1e-12);
  });

  it.each([
    [1e-10, -6.361340902404056],
    [0.001, -3.090232306167813],
    [0.01, -2.3263478740408408],
    [0.025, -1.9599639845400545],
    [0.05, -1.6448536269514729],
    [0.1, -1.2815515655446004],
    [0.5, 0],
    [0.9, 1.2815515655446004],
    [0.95, 1.6448536269514722],
    [0.975, 1.959963984540054],
    [0.99, 2.3263478740408408],
    [0.995, 2.5758293035489004],
    [0.999, 3.090232306167813],
    [1 - 1e-10, 6.361340889697422],
  ])('quantile at %d', (p, expected) => {
    expectClose(normalQuantile(p), expected, 1e-14);
  });

  it('has the right density and limits', () => {
    expectClose(normalPdf(0), 1 / Math.sqrt(2 * Math.PI), 1e-15);
    expectClose(normalPdf(1.3), 0.17136859204780736, 1e-14);
    expect(normalQuantile(0)).toBe(-Infinity);
    expect(normalQuantile(1)).toBe(Infinity);
    expect(normalCdf(-Infinity)).toBe(0);
    expect(normalCdf(Infinity)).toBe(1);
    expect(normalCdf(NaN)).toBeNaN();
    expect(() => normalQuantile(1.1)).toThrow(RangeError);
    expect(() => normalQuantile(NaN)).toThrow(RangeError);
  });

  it('quantile inverts the cdf', () => {
    fc.assert(
      fc.property(fc.double({ min: 1e-12, max: 1 - 1e-12, noNaN: true }), (p) => {
        expectClose(normalCdf(normalQuantile(p)), p, 1e-11);
      }),
    );
  });
});

describe('chi-square', () => {
  // Upper-tail critical values at α = 0.10, 0.05, 0.01, 0.001.
  const table: [number, [number, number, number, number]][] = [
    [1, [2.705543454095404, 3.841458820694124, 6.6348966010212145, 10.827566170662733]],
    [2, [4.605170185988092, 5.991464547107979, 9.21034037197618, 13.815510557964274]],
    [3, [6.251388631170325, 7.814727903251179, 11.344866730144373, 16.26623619623813]],
    [4, [7.779440339734858, 9.487729036781154, 13.276704135987622, 18.46682695290317]],
    [5, [9.236356899781123, 11.070497693516351, 15.08627246938899, 20.515005652432873]],
    [10, [15.987179172105265, 18.307038053275146, 23.209251158954356, 29.58829844507442]],
    [20, [28.41198058430563, 31.410432844230918, 37.56623478662507, 45.31474661812586]],
    [30, [40.2560237387118, 43.77297182574219, 50.89218131151707, 59.70306430442994]],
    [50, [63.167121005726315, 67.5048065495412, 76.1538912490127, 86.66081519040317]],
    [100, [118.49800381106212, 124.34211340400407, 135.80672317102676, 149.44925277903886]],
    [1000, [1057.723901381614, 1074.679448803441, 1106.9689943522174, 1143.9170926196791]],
  ];
  const alphas = [0.1, 0.05, 0.01, 0.001];

  it.each(table)('critical values with %d degrees of freedom', (df, values) => {
    values.forEach((x, i) => {
      const alpha = alphas[i] as number;
      expectClose(chiSquareQuantile(1 - alpha, df), x, 1e-12);
      expectClose(chiSquareSf(x, df), alpha, 1e-11);
      expectClose(chiSquareCdf(x, df), 1 - alpha, 1e-12);
    });
  });

  it.each([
    [10, 1, 0.001565402258002549],
    [50, 1, 1.537459794428033e-12],
    [100, 3, 1.5541594313896026e-21],
    [0.5, 2, 0.7788007830714049], // e^(−1/4)
    [20, 10, 0.029252688076961124],
    [1000, 1000, 0.49405285382923964],
    [1100, 1000, 0.014614408126295192],
    [0.001, 1, 0.9747728793699604],
  ])('P(X > %d) with %d degrees of freedom', (x, df, expected) => {
    expectClose(chiSquareSf(x, df), expected, 1e-11);
  });

  it('has the right density and ends', () => {
    expectClose(chiSquarePdf(3, 4), 0.1673476201113224, 1e-14);
    expectClose(chiSquarePdf(0.5, 1), 0.43939128946772243, 1e-14);
    expectClose(chiSquarePdf(2, 2), 0.18393972058572114, 1e-14);
    expect(chiSquarePdf(-1, 3)).toBe(0);
    expect(chiSquarePdf(0, 1)).toBe(Infinity);
    expect(chiSquarePdf(0, 2)).toBe(0.5);
    expect(chiSquarePdf(0, 3)).toBe(0);
    expect(chiSquareCdf(0, 3)).toBe(0);
    expect(chiSquareSf(-2, 3)).toBe(1);
    expect(chiSquareSf(NaN, 3)).toBeNaN();
    expect(chiSquareCdf(NaN, 3)).toBeNaN();
    expect(chiSquareQuantile(0, 3)).toBe(0);
    expect(chiSquareQuantile(1, 3)).toBe(Infinity);
    expect(() => chiSquareSf(1, 0)).toThrow(RangeError);
    expect(() => chiSquareQuantile(0.5, -1)).toThrow(RangeError);
  });

  it('quantile inverts the cdf', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1e-9, max: 1 - 1e-9, noNaN: true }),
        fc.double({ min: 0.5, max: 5000, noNaN: true }),
        (p, df) => {
          const x = chiSquareQuantile(p, df);
          if (p > 0.5) expectClose(chiSquareSf(x, df), 1 - p, 1e-9);
          else expectClose(chiSquareCdf(x, df), p, 1e-9);
        },
      ),
    );
  });
});

describe("Student's t", () => {
  // One-sided upper quantiles at 0.90, 0.95, 0.975, 0.99, 0.995, 0.9995.
  const table: [number, number[]][] = [
    [
      1,
      [
        3.0776835371752544, 6.313751514675037, 12.706204736174694, 31.820515953773935,
        63.656741162871526, 636.6192487687897,
      ],
    ],
    [
      2,
      [
        1.8856180831641272, 2.9199855803537242, 4.302652729749462, 6.9645567342832715,
        9.924843200918287, 31.599054576445365,
      ],
    ],
    [
      3,
      [
        1.637744353696209, 2.3533634348018233, 3.1824463052837078, 4.540702858568132,
        5.840909309733355, 12.923978636687961,
      ],
    ],
    [
      5,
      [
        1.4758840488244815, 2.0150483733330233, 2.5705818356363146, 3.3649299989072174,
        4.032142983555228, 6.868826625881276,
      ],
    ],
    [
      10,
      [
        1.372183641110336, 1.8124611228116756, 2.228138851986274, 2.7637694581126957,
        3.16927267261695, 4.586893858702708,
      ],
    ],
    [
      20,
      [
        1.3253407069850465, 1.7247182429207866, 2.085963447265864, 2.527977002741573,
        2.8453397097861077, 3.8495162749308744,
      ],
    ],
    [
      30,
      [
        1.3104150253913955, 1.697260886593957, 2.0422724563012378, 2.457261542400591,
        2.7499956535672254, 3.6459586350420627,
      ],
    ],
    [
      60,
      [
        1.295821093515731, 1.6706488649046363, 2.0002978220142604, 2.3901194726249133,
        2.6602830288550368, 3.460200469196392,
      ],
    ],
    [
      120,
      [
        1.288646233656378, 1.6576508993552352, 1.9799304050824402, 2.357824612648755,
        2.6174211451068654, 3.373453768562533,
      ],
    ],
    [
      1000,
      [
        1.2823987214609247, 1.6463788172854643, 1.9623390808264083, 2.330082674755513,
        2.580754698065951, 3.300282648423944,
      ],
    ],
    [
      1e6,
      [
        1.281552412129939, 1.6448551507220404, 1.959966356814107, 2.326351603120805,
        2.5758342201053344, 3.2905364612487222,
      ],
    ],
  ];
  const ps = [0.9, 0.95, 0.975, 0.99, 0.995, 0.9995];

  it.each(table)('critical values with %d degrees of freedom', (df, values) => {
    values.forEach((t, i) => {
      const p = ps[i] as number;
      // Huge df loses a few digits to ln Γ differences of numbers near 10^7.
      const rel = df >= 1e6 ? 1e-9 : 1e-12;
      expectClose(studentTQuantile(p, df), t, rel);
      expectClose(studentTQuantile(1 - p, df), -t, rel);
      expectClose(studentTSf(t, df), 1 - p, rel * 100);
    });
  });

  it.each([
    [2, 5, 0.050969739414929174],
    [1, 1, 0.25],
    [3.5, 12.3, 0.002115267617017044],
    [10, 3, 0.0010641995292070751],
    [0.1, 1e6, 0.4601721727460216],
    [2.5, 2e7, 0.006209669297032201],
    [40, 8, 8.392859439572896e-11],
  ])('P(T > %d) with %d degrees of freedom', (t, df, expected) => {
    expectClose(studentTSf(t, df), expected, df >= 1e6 ? 1e-8 : 1e-12);
  });

  it('is symmetric, has the right density and goes to the normal', () => {
    expectClose(studentTCdf(-2, 5), 0.050969739414929174, 1e-12);
    expectClose(studentTSf(-2, 5), 1 - 0.050969739414929174, 1e-14);
    expectClose(studentTPdf(1.3, 7), 0.16209295508952076, 1e-14);
    expect(studentTPdf(1.3, Infinity)).toBe(normalPdf(1.3));
    expect(studentTSf(1.3, Infinity)).toBe(normalSf(1.3));
    expect(studentTQuantile(0.975, Infinity)).toBe(normalQuantile(0.975));
    expect(studentTSf(Infinity, 4)).toBe(0);
    expect(studentTSf(-Infinity, 4)).toBe(1);
    expect(studentTSf(NaN, 4)).toBeNaN();
    expect(studentTQuantile(0.5, 4)).toBe(0);
    expect(studentTQuantile(0, 4)).toBe(-Infinity);
    expect(studentTQuantile(1, 4)).toBe(Infinity);
    expect(() => studentTSf(1, 0)).toThrow(RangeError);
    expect(() => studentTQuantile(2, 4)).toThrow(RangeError);
  });

  it('quantile inverts the cdf for fractional degrees of freedom (Welch)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1e-9, max: 1 - 1e-9, noNaN: true }),
        fc.double({ min: 1, max: 1e5, noNaN: true }),
        (p, df) => {
          const t = studentTQuantile(p, df);
          if (p > 0.5) expectClose(studentTSf(t, df), 1 - p, 1e-8);
          else expectClose(studentTCdf(t, df), p, 1e-8);
        },
      ),
    );
  });
});
