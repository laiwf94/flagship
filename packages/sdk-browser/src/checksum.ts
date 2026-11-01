/**
 * Canonical JSON (RFC 8785): no whitespace, object keys sorted by UTF-16 code
 * units, numbers and strings exactly as JSON.stringify writes them. The same
 * rules as canonicalJson in @flagship/core, repeated here so the browser SDK
 * stays free of dependencies; the conformance vectors keep the two in step.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${value} has no JSON form`);
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') throw new TypeError(`a ${typeof value} has no JSON form`);
  if (Array.isArray(value)) {
    return `[${value.map((v: unknown) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const item = record[key];
    if (item !== undefined) parts.push(`${JSON.stringify(key)}:${canonicalJson(item)}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * SHA-256 hex of a string's UTF-8 bytes through WebCrypto, or undefined where
 * WebCrypto is missing (it needs a secure context: https or localhost).
 */
export async function sha256Hex(
  text: string,
  subtle: SubtleCrypto | undefined,
): Promise<string | undefined> {
  if (subtle === undefined) return undefined;
  const digest = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(text)));
  let out = '';
  for (const b of digest) out += b.toString(16).padStart(2, '0');
  return out;
}
