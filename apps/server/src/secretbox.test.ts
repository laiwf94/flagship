import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseSecretKey, SecretBox, SecretKeyError } from './secretbox.js';

const key = randomBytes(32);

describe('secret box', () => {
  it('seals and opens a secret bound to its context, without the plaintext in the output', () => {
    const box = new SecretBox(key);
    const secret = 'whsec_' + randomBytes(32).toString('base64url');
    const sealed = box.seal(secret, 'webhook:a');
    expect(sealed.keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(sealed.value.length).toBe(1 + 12 + 16 + Buffer.byteLength(secret));
    expect(sealed.value.includes(Buffer.from(secret))).toBe(false);
    expect(box.open(sealed, 'webhook:a')).toBe(secret);
    // A fresh IV every time.
    expect(box.seal(secret, 'webhook:a').value.equals(sealed.value)).toBe(false);
  });

  it('refuses a value moved to another row, tampered with, or sealed under another key', () => {
    const box = new SecretBox(key);
    const sealed = box.seal('s3cret', 'webhook:a');
    expect(() => box.open(sealed, 'webhook:b')).toThrow(SecretKeyError);

    for (const at of [0, 5, 20, sealed.value.length - 1]) {
      const bad = Buffer.from(sealed.value);
      bad[at] = (bad[at] ?? 0) ^ 1;
      expect(() => box.open({ keyId: sealed.keyId, value: bad }, 'webhook:a')).toThrow(
        SecretKeyError,
      );
    }
    expect(() =>
      box.open({ keyId: sealed.keyId, value: sealed.value.subarray(0, 20) }, 'webhook:a'),
    ).toThrow(/unknown sealed format/);

    const other = new SecretBox(randomBytes(32));
    expect(other.keyId).not.toBe(box.keyId);
    expect(() => other.open(sealed, 'webhook:a')).toThrow(/not the configured key/);
    // Same key id but a different key (forged id) still fails authentication.
    expect(() => other.open({ keyId: other.keyId, value: sealed.value }, 'webhook:a')).toThrow(
      /failed authentication/,
    );
    expect(new SecretBox(key).keyId).toBe(box.keyId);
  });

  it('parses 32-byte keys in base64 or base64url and nothing else', () => {
    const raw = randomBytes(32);
    expect(parseSecretKey(raw.toString('base64')).equals(raw)).toBe(true);
    expect(parseSecretKey(` ${raw.toString('base64url')}\n`).equals(raw)).toBe(true);
    expect(() => parseSecretKey(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
    expect(() => parseSecretKey('not base64!')).toThrow(/base64/);
    expect(() => new SecretBox(randomBytes(16))).toThrow(/32 bytes/);
  });
});
