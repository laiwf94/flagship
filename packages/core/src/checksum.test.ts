import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { rulesetArb } from '../test/arbitraries.js';
import { booleanFlag, ruleset, segment } from '../test/fixtures.js';
import {
  EMPTY_CHECKSUM,
  RulesetDigest,
  canonicalJson,
  entryDigest,
  evaluationChecksum,
  rulesetChecksum,
  sha256,
  sha256Text,
  toHex,
  type Sha256Text,
} from './checksum.js';
import type { Ruleset } from './model.js';
import { validateRuleset } from './validate.js';

const native: Sha256Text = (text) => createHash('sha256').update(text, 'utf8').digest();
const nativeHex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('sha256', () => {
  it('matches the FIPS 180-4 examples', () => {
    expect(toHex(sha256(new Uint8Array()))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(toHex(sha256Text('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(toHex(sha256Text('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
    expect(toHex(sha256Text('a'.repeat(1_000_000)))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    );
  });

  it('agrees with node:crypto on every length around the block and padding boundaries', () => {
    for (let n = 0; n <= 200; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff);
      expect(toHex(sha256(bytes)), `length ${n}`).toBe(nativeHex(bytes));
    }
  });

  it('agrees with node:crypto on arbitrary text, lone surrogates included', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 300 }), (text) => {
        expect(toHex(sha256Text(text))).toBe(toHex(native(text)));
      }),
      { numRuns: 300 },
    );
  });
});

describe('canonicalJson', () => {
  it('sorts keys by UTF-16 code units at every depth and drops undefined properties', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null }, e: undefined })).toBe(
      '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}',
    );
    // U+1F600 is the surrogate pair D83D DE00, so it sorts before U+FF5E (RFC 8785, 3.2.3).
    expect(canonicalJson({ '～': 1, '\u{1f600}': 2, é: 3, Z: 4, a: 5 })).toBe(
      '{"Z":4,"a":5,"é":3,"😀":2,"～":1}',
    );
  });

  it('writes numbers and strings the way JSON.stringify does', () => {
    expect(canonicalJson([1e21, 0.1, -0, 1.5, 5e-7, 123456789012, 'a"\\\n 😀', true])).toBe(
      '[1e+21,0.1,0,1.5,5e-7,123456789012,"a\\"\\\\\\n 😀",true]',
    );
    expect(canonicalJson([undefined, null])).toBe('[null,null]');
  });

  it('refuses values that have no JSON form', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(/no JSON form/);
    expect(() => canonicalJson(Infinity)).toThrow(/no JSON form/);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(/function has no JSON form/);
    expect(() => canonicalJson(undefined)).toThrow(/undefined has no JSON form/);
  });

  it('orders array-index keys as strings too, though JavaScript enumerates them first', () => {
    const value = JSON.parse('{"a":1,"10":2,"9":3,"-x":4,"__proto__":5,"0":{"2":1,"10":2}}');
    expect(canonicalJson(value)).toBe(
      '{"-x":4,"0":{"10":2,"2":1},"10":2,"9":3,"__proto__":5,"a":1}',
    );
    expect(canonicalJson({ list: [{ b: 1, a: 2 }, { 1: 'x' }] })).toBe(
      '{"list":[{"a":2,"b":1},{"1":"x"}]}',
    );
    // 2^32 - 1 is not an array index, so it keeps its place like any other key.
    expect(canonicalJson({ b: 1, '4294967295': 2 })).toBe('{"4294967295":2,"b":1}');
  });

  it('agrees with a plain reference implementation on arbitrary JSON', () => {
    const reference = (v: unknown): string => {
      if (v === null || typeof v !== 'object') return JSON.stringify(v);
      if (Array.isArray(v)) return `[${v.map(reference).join(',')}]`;
      const o = v as Record<string, unknown>;
      return `{${Object.keys(o)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${reference(o[k])}`)
        .join(',')}}`;
    };
    const key = fc.oneof(
      fc.constantFrom('0', '1', '2', '9', '10', '01', '-1', '__proto__', 'é', '😀', '～', 'a', 'Z'),
      fc.string({ maxLength: 4 }),
    );
    const json = fc.letrec((tie) => ({
      value: fc.oneof(
        { depthSize: 'small' },
        fc.constant(null),
        fc.boolean(),
        fc.double({ noNaN: true, noDefaultInfinity: true }),
        fc.string({ unit: 'binary', maxLength: 8 }),
        fc.array(tie('value'), { maxLength: 4 }),
        fc.dictionary(key, tie('value'), { maxKeys: 5 }),
      ),
    })).value;
    fc.assert(
      fc.property(json, (value) => {
        expect(canonicalJson(value)).toBe(reference(value));
      }),
      { numRuns: 1000 },
    );
  });

  it('gives the same text for equal values whatever their key order, and parses back', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const text = canonicalJson(value);
        const reordered: unknown = JSON.parse(JSON.stringify(value), (_k, v: unknown) =>
          typeof v === 'object' && v !== null && !Array.isArray(v)
            ? Object.fromEntries(Object.entries(v).reverse())
            : v,
        );
        expect(canonicalJson(reordered)).toBe(text);
        expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(value)));
      }),
      { numRuns: 300 },
    );
  });
});

describe('ruleset checksums', () => {
  const a = booleanFlag('a');
  const b = booleanFlag('b', { clientSide: true });
  const s = segment('beta', { included: ['u1'] });

  it('is all zeros for an empty ruleset and does not depend on version or environment', () => {
    expect(rulesetChecksum(ruleset([]))).toBe(EMPTY_CHECKSUM);
    const one = rulesetChecksum(ruleset([a, b], [s]));
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    const moved: Ruleset = { ...ruleset([a, b], [s]), version: 99, environment: 'x' };
    expect(rulesetChecksum(moved)).toBe(one);
  });

  it('is the sum of the entry digests modulo 2^256', () => {
    const digests = [entryDigest('flag', 'a', a), entryDigest('segment', 'beta', s)];
    let sum = 0n;
    for (const d of digests) sum = (sum + BigInt(`0x${toHex(d)}`)) % 2n ** 256n;
    expect(rulesetChecksum(ruleset([a], [s]))).toBe(sum.toString(16).padStart(64, '0'));
    expect(toHex(entryDigest('flag', 'a', a))).toBe(
      toHex(sha256Text(`flag\na\n${canonicalJson(a)}`)),
    );
  });

  it('changes with any byte of any entry, its version included', () => {
    const base = rulesetChecksum(ruleset([a, b], [s]));
    expect(rulesetChecksum(ruleset([{ ...a, version: 2 }, b], [s]))).not.toBe(base);
    expect(rulesetChecksum(ruleset([a, { ...b, salt: 'b2' }], [s]))).not.toBe(base);
    expect(rulesetChecksum(ruleset([a, b], [{ ...s, included: ['u2'] }]))).not.toBe(base);
    expect(rulesetChecksum(ruleset([a, b]))).not.toBe(base);
    // A flag and a segment can share a key without their digests colliding.
    const same = { key: 'beta', included: [], excluded: [], rules: [], version: 1 };
    expect(toHex(entryDigest('segment', 'beta', same))).not.toBe(
      toHex(entryDigest('flag', 'beta', same as never)),
    );
  });

  it('is the same with the native hash and accepted by the ruleset schema', () => {
    const r = ruleset([a, b], [s]);
    const checksum = rulesetChecksum(r, native);
    expect(checksum).toBe(rulesetChecksum(r));
    expect(validateRuleset({ ...r, checksum }).ok).toBe(true);
    expect(validateRuleset({ ...r, checksum: 'ABC' }).ok).toBe(false);
  });

  it('prepare previews a change without making it, and apply makes it', () => {
    const d = RulesetDigest.of(ruleset([a], [s]));
    const before = d.checksum;
    const next = d.prepare('flag', 'b', b);
    expect(d.checksum).toBe(before);
    expect(next.checksum).toBe(rulesetChecksum(ruleset([a, b], [s])));
    next.apply();
    expect(d.checksum).toBe(next.checksum);
    expect(d.size).toBe(3);
    d.prepare('segment', 'beta', null).apply();
    d.prepare('flag', 'missing', null).apply();
    expect(d.checksum).toBe(rulesetChecksum(ruleset([a, b])));
    d.prepare('flag', 'a', null).apply();
    d.prepare('flag', 'b', null).apply();
    expect(d.checksum).toBe(EMPTY_CHECKSUM);
    expect(d.size).toBe(0);
  });

  it('kept up to date patch by patch, always equals the checksum of the result', () => {
    const patches = fc.array(
      fc.tuple(fc.integer({ min: 0, max: 7 }), fc.boolean(), fc.nat(50), fc.boolean()),
      { maxLength: 30 },
    );
    fc.assert(
      fc.property(rulesetArb, patches, (start, steps) => {
        const current = structuredClone(start);
        const d = RulesetDigest.of(current);
        for (const [i, remove, version, isSegment] of steps) {
          if (isSegment) {
            const key = `segment-${i % 4}`;
            const value = remove ? null : segment(key, { version });
            d.prepare('segment', key, value).apply();
            if (value === null) Reflect.deleteProperty(current.segments, key);
            else current.segments[key] = value;
          } else {
            const key = `flag-${i}`;
            const value = remove ? null : booleanFlag(key, { version });
            d.prepare('flag', key, value).apply();
            if (value === null) Reflect.deleteProperty(current.flags, key);
            else current.flags[key] = value;
          }
          expect(d.checksum).toBe(rulesetChecksum(current));
        }
      }),
      { numRuns: 100 },
    );
  });

  it('evaluationChecksum is SHA-256 of the canonical flags object', () => {
    const flags = { b: { value: 1, variant: 'x', reason: 'DEFAULT' }, a: { reason: 'ERROR' } };
    expect(evaluationChecksum(flags)).toBe(
      createHash('sha256').update(canonicalJson(flags)).digest('hex'),
    );
    expect(evaluationChecksum(flags, native)).toBe(evaluationChecksum(flags));
  });
});
