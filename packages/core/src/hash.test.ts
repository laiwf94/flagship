import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { murmur3, utf8 } from './hash.js';

/**
 * A deliberately naive MurmurHash3 written straight from the reference C code
 * with BigInt arithmetic, so it shares no tricks with the fast version.
 */
function referenceMurmur3(input: string, seed: number): number {
  const bytes = [...new TextEncoder().encode(input)];
  const mask = 0xffffffffn;
  const mul = (a: bigint, b: bigint) => (a * b) & mask;
  const rotl = (x: bigint, r: bigint) => ((x << r) | (x >> (32n - r))) & mask;
  let h = BigInt(seed) & mask;
  const blocks = Math.floor(bytes.length / 4);
  for (let b = 0; b < blocks; b++) {
    let k = 0n;
    for (let j = 3; j >= 0; j--) k = (k << 8n) | BigInt(bytes[b * 4 + j] ?? 0);
    k = mul(rotl(mul(k, 0xcc9e2d51n), 15n), 0x1b873593n);
    h = rotl(h ^ k, 13n);
    h = (mul(h, 5n) + 0xe6546b64n) & mask;
  }
  let k = 0n;
  const tail = bytes.slice(blocks * 4);
  for (let j = tail.length - 1; j >= 0; j--) k = (k << 8n) | BigInt(tail[j] ?? 0);
  if (tail.length > 0) h ^= mul(rotl(mul(k, 0xcc9e2d51n), 15n), 0x1b873593n);
  h ^= BigInt(bytes.length);
  h ^= h >> 16n;
  h = mul(h, 0x85ebca6bn);
  h ^= h >> 13n;
  h = mul(h, 0xc2b2ae35n);
  h ^= h >> 16n;
  return Number(h);
}

describe('utf8', () => {
  it('matches TextEncoder, including lone surrogates', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 40 }), (s) => {
        expect([...utf8(s)]).toEqual([...new TextEncoder().encode(s)]);
      }),
      { numRuns: 3000 },
    );
    expect([...utf8('\ud800x')]).toEqual([0xef, 0xbf, 0xbd, 0x78]);
  });
});

describe('murmur3', () => {
  it.each([
    ['', 0, 0x00000000],
    ['', 1, 0x514e28b7],
    ['', 0xffffffff, 0x81f16f39],
    ['test', 0, 0xba6bd213],
    ['hello', 0, 0x248bfa47],
    ['Hello, world!', 0, 0xc0363e43],
    ['The quick brown fox jumps over the lazy dog', 0, 0x2e4ff723],
  ])('matches the published vector for %j seed %d', (input, seed, expected) => {
    expect(murmur3(input, seed)).toBe(expected);
  });

  it('agrees with a naive reference on arbitrary unicode strings and seeds', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 64 }), fc.nat(), (s, seed) => {
        expect(murmur3(s, seed)).toBe(referenceMurmur3(s, seed));
      }),
      { numRuns: 2000 },
    );
  });
});
