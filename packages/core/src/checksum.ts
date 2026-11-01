import { utf8 } from './hash.js';
import type { Flag, Ruleset, Segment } from './model.js';

/**
 * Hashes a string's UTF-8 bytes with SHA-256 and returns the 32-byte digest.
 * The core ships a plain JavaScript implementation so it runs anywhere and
 * synchronously; Node callers pass `node:crypto` instead, which is several
 * times faster on large rulesets.
 */
export type Sha256Text = (text: string) => Uint8Array;

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 (FIPS 180-4) of `data`. */
export function sha256(data: Uint8Array): Uint8Array {
  const length = data.length;
  // Message, 0x80, zero padding, then the bit length as a 64-bit big-endian integer.
  const padded = new Uint8Array((((length + 8) >> 6) + 1) << 6);
  padded.set(data);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(length / 0x20000000));
  view.setUint32(padded.length - 4, (length << 3) >>> 0);

  const w = new Uint32Array(64);
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15] ?? 0;
      const b = w[i - 2] ?? 0;
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) | 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let i = 0; i < 64; i++) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + s1 + ch + (K[i] ?? 0) + (w[i] ?? 0)) | 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + h) | 0;
  }

  const out = new Uint8Array(32);
  const o = new DataView(out.buffer);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((v, i) => {
    o.setUint32(i * 4, v >>> 0);
  });
  return out;
}

/** The default `Sha256Text`: UTF-8 encode, then the plain JavaScript SHA-256. */
export const sha256Text: Sha256Text = (text) => sha256(utf8(text));

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += (b < 16 ? '0' : '') + b.toString(16);
  return out;
}

/** Canonical JSON written out by hand; the reference the fast path must match. */
function canonicalWalk(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`${value} has no JSON form`);
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new TypeError(`a ${typeof value} has no JSON form`);
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value as unknown[]) {
      parts.push(item === undefined ? 'null' : canonicalWalk(item));
    }
    return `[${parts.join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  // The default sort compares UTF-16 code units, which is what JCS specifies.
  for (const key of Object.keys(record).sort()) {
    const item = record[key];
    if (item !== undefined) parts.push(`${JSON.stringify(key)}:${canonicalWalk(item)}`);
  }
  return `{${parts.join(',')}}`;
}

/** Keys JavaScript always enumerates first, in numeric order, whatever the insertion order. */
const ARRAY_INDEX = /^(?:0|[1-9]\d{0,9})$/;

/** Thrown by sortKeys when an object needs the hand-written path. */
const NEEDS_WALK = new Error('object has array-index keys');

/**
 * JSON.stringify replacer that hands back each object with its keys in sorted
 * order (a copy only when they aren't sorted already), so the native
 * serialiser does the rest, about 1.5 times faster than walking by hand. An
 * object with an array-index key such as "10" can't be reordered that way,
 * since JavaScript enumerates those keys numerically first, so it sends the
 * caller to the hand-written path. Values JSON can't hold are refused rather
 * than dropped.
 */
function sortKeys(_key: string, value: unknown): unknown {
  switch (typeof value) {
    case 'string':
    case 'boolean':
    case 'undefined':
      // JSON.stringify drops undefined from objects and writes null in arrays.
      return value;
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`${value} has no JSON form`);
      return value;
    case 'object':
      break;
    default:
      throw new TypeError(`a ${typeof value} has no JSON form`);
  }
  if (value === null || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  let sorted = true;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i] ?? '';
    if (ARRAY_INDEX.test(key) && Number(key) < 0xffffffff) throw NEEDS_WALK;
    if (i > 0 && (keys[i - 1] ?? '') > key) sorted = false;
  }
  if (sorted) return record;
  keys.sort();
  // No prototype, so a "__proto__" key is copied as data like any other.
  const copy = Object.create(null) as Record<string, unknown>;
  for (const k of keys) copy[k] = record[k];
  return copy;
}

/**
 * Canonical JSON in the sense of RFC 8785 (JCS): no whitespace, object keys
 * sorted by UTF-16 code units, numbers and strings serialised exactly as
 * ECMAScript's JSON.stringify does. Two equal JSON values always give the
 * same text, whatever order their keys arrived in. Properties whose value is
 * undefined are left out and undefined array items become null, as
 * JSON.stringify does; anything else JSON can't hold is an error.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) throw new TypeError('a undefined has no JSON form');
  try {
    return JSON.stringify(value, sortKeys);
  } catch (err) {
    if (err === NEEDS_WALK) return canonicalWalk(value);
    throw err;
  }
}

/** 64 zeros: the checksum of a ruleset with no flags and no segments. */
export const EMPTY_CHECKSUM = '0'.repeat(64);

export type EntryKind = 'flag' | 'segment';

/**
 * SHA-256 of one flag or segment: `kind`, newline, key, newline, then the
 * value's canonical JSON. Every byte of the entry, its version included,
 * goes into it.
 */
export function entryDigest(
  kind: EntryKind,
  key: string,
  value: Flag | Segment,
  hash: Sha256Text = sha256Text,
): Uint8Array {
  return hash(`${kind}\n${key}\n${canonicalJson(value)}`);
}

/** Adds (sign 1) or subtracts (sign -1) a 32-byte big-endian number, modulo 2^256. */
function accumulate(sum: Uint32Array, digest: Uint8Array, sign: 1 | -1): void {
  let carry = 0;
  for (let i = 7; i >= 0; i--) {
    const j = i * 4;
    const word =
      (((digest[j] ?? 0) << 24) |
        ((digest[j + 1] ?? 0) << 16) |
        ((digest[j + 2] ?? 0) << 8) |
        (digest[j + 3] ?? 0)) >>>
      0;
    const next = (sum[i] ?? 0) + sign * word + carry;
    // Floor division keeps the carry right for both signs (a borrow is -1).
    carry = Math.floor(next / 0x100000000);
    sum[i] = next - carry * 0x100000000;
  }
}

function sumHex(sum: Uint32Array): string {
  let out = '';
  for (const word of sum) out += word.toString(16).padStart(8, '0');
  return out;
}

/**
 * The checksum of a ruleset's contents and how to keep it current.
 *
 * The checksum is the sum, modulo 2^256, of the entry digest of every flag
 * and segment, written as 64 hex digits. A sum doesn't depend on order, and
 * replacing one entry is one subtraction and one addition, so an SDK can
 * check every patch it applies without rehashing the whole ruleset. The
 * ruleset's own version and environment are not part of it: SDKs check
 * versions on their own.
 */
export class RulesetDigest {
  private readonly entries = new Map<string, Uint8Array>();
  private readonly sum = new Uint32Array(8);

  private constructor(private readonly hash: Sha256Text) {}

  static of(
    ruleset: Pick<Ruleset, 'flags' | 'segments'>,
    hash: Sha256Text = sha256Text,
  ): RulesetDigest {
    const d = new RulesetDigest(hash);
    for (const [key, flag] of Object.entries(ruleset.flags)) d.put('flag', key, flag);
    for (const [key, segment] of Object.entries(ruleset.segments)) d.put('segment', key, segment);
    return d;
  }

  get checksum(): string {
    return sumHex(this.sum);
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * Works out the checksum the ruleset would have with one entry replaced
   * (or removed, when `value` is null) without changing anything; `apply`
   * then makes the change. This lets a caller compare before committing.
   */
  prepare(
    kind: EntryKind,
    key: string,
    value: Flag | Segment | null,
  ): { checksum: string; apply: () => void } {
    const id = `${kind}:${key}`;
    const before = this.entries.get(id);
    const after = value === null ? undefined : entryDigest(kind, key, value, this.hash);
    const sum = this.sum.slice();
    if (before !== undefined) accumulate(sum, before, -1);
    if (after !== undefined) accumulate(sum, after, 1);
    return {
      checksum: sumHex(sum),
      apply: () => {
        this.sum.set(sum);
        if (after === undefined) this.entries.delete(id);
        else this.entries.set(id, after);
      },
    };
  }

  private put(kind: EntryKind, key: string, value: Flag | Segment): void {
    const digest = entryDigest(kind, key, value, this.hash);
    accumulate(this.sum, digest, 1);
    this.entries.set(`${kind}:${key}`, digest);
  }
}

/** The checksum of a whole ruleset; see RulesetDigest. */
export function rulesetChecksum(
  ruleset: Pick<Ruleset, 'flags' | 'segments'>,
  hash: Sha256Text = sha256Text,
): string {
  return RulesetDigest.of(ruleset, hash).checksum;
}

/**
 * The checksum of an evaluation answer (what /sdk/v1/evaluate returns for
 * browsers): plain SHA-256 of the canonical JSON of the flags object, which
 * a browser can check with WebCrypto alone.
 */
export function evaluationChecksum(flags: unknown, hash: Sha256Text = sha256Text): string {
  return toHex(hash(canonicalJson(flags)));
}
