import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Encrypts small secrets at rest (webhook signing secrets) with AES-256-GCM
 * under the key in FLAGSHIP_SECRET_KEY.
 *
 * A sealed value is `version (1) | iv (12) | tag (16) | ciphertext`. Each
 * value is bound to the row it belongs to through the additional
 * authenticated data, so a ciphertext copied into another row fails to open
 * rather than handing that row someone else's secret. The key id stored next
 * to a value says which key sealed it, so a missing or changed key is reported
 * as such instead of as corrupt data.
 */

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER = 1 + IV_BYTES + TAG_BYTES;

export class SecretKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretKeyError';
  }
}

/** Parses FLAGSHIP_SECRET_KEY: 32 bytes, base64 or base64url. */
export function parseSecretKey(text: string): Buffer {
  const trimmed = text.trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed)) {
    throw new SecretKeyError('must be base64');
  }
  const key = Buffer.from(trimmed.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (key.length !== 32) throw new SecretKeyError('must decode to exactly 32 bytes');
  return key;
}

export interface Sealed {
  keyId: string;
  value: Buffer;
}

export class SecretBox {
  readonly keyId: string;

  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new SecretKeyError('key must be 32 bytes');
    // Identifies the key without revealing anything usable about it.
    this.keyId = createHash('sha256')
      .update('flagship secret key id\0')
      .update(key)
      .digest('hex')
      .slice(0, 16);
  }

  seal(plaintext: string, context: string): Sealed {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      keyId: this.keyId,
      value: Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]),
    };
  }

  /** Throws SecretKeyError when the value was sealed under another key or doesn't open. */
  open(sealed: Sealed, context: string): string {
    if (sealed.keyId !== this.keyId) {
      throw new SecretKeyError(`sealed under key ${sealed.keyId}, not the configured key`);
    }
    const v = sealed.value;
    if (v.length < HEADER || v[0] !== VERSION) throw new SecretKeyError('unknown sealed format');
    const decipher = createDecipheriv('aes-256-gcm', this.key, v.subarray(1, 1 + IV_BYTES));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(v.subarray(1 + IV_BYTES, HEADER));
    try {
      return Buffer.concat([decipher.update(v.subarray(HEADER)), decipher.final()]).toString(
        'utf8',
      );
    } catch {
      throw new SecretKeyError('sealed value failed authentication');
    }
  }
}
