/**
 * UTF-8 bytes of a string, written out so the core has no dependency on
 * TextEncoder. Lone surrogates become U+FFFD, exactly as TextEncoder does.
 */
export function utf8(input: string): Uint8Array {
  const out = new Uint8Array(input.length * 3);
  let n = 0;
  for (const ch of input) {
    let cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
    if (cp < 0x80) {
      out[n++] = cp;
    } else if (cp < 0x800) {
      out[n++] = 0xc0 | (cp >> 6);
      out[n++] = 0x80 | (cp & 0x3f);
    } else if (cp < 0x10000) {
      out[n++] = 0xe0 | (cp >> 12);
      out[n++] = 0x80 | ((cp >> 6) & 0x3f);
      out[n++] = 0x80 | (cp & 0x3f);
    } else {
      out[n++] = 0xf0 | (cp >> 18);
      out[n++] = 0x80 | ((cp >> 12) & 0x3f);
      out[n++] = 0x80 | ((cp >> 6) & 0x3f);
      out[n++] = 0x80 | (cp & 0x3f);
    }
  }
  return out.subarray(0, n);
}

/**
 * MurmurHash3, x86 32-bit variant, over the UTF-8 bytes of `input`.
 * Chosen because it is fast in plain JavaScript (no async WebCrypto in the
 * browser), well distributed, and the same function Unleash uses for
 * bucketing, so the algorithm is easy to reproduce in any language.
 */
export function murmur3(input: string, seed = 0): number {
  const data = utf8(input);
  const length = data.length;
  const tail = length & ~3;
  let h = seed >>> 0;

  for (let i = 0; i < tail; i += 4) {
    let k =
      (data[i] ?? 0) |
      ((data[i + 1] ?? 0) << 8) |
      ((data[i + 2] ?? 0) << 16) |
      ((data[i + 3] ?? 0) << 24);
    k = Math.imul(k, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b873593);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }

  const rest = length & 3;
  if (rest > 0) {
    let k = 0;
    if (rest === 3) k ^= (data[tail + 2] ?? 0) << 16;
    if (rest >= 2) k ^= (data[tail + 1] ?? 0) << 8;
    k ^= data[tail] ?? 0;
    k = Math.imul(k, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b873593);
    h ^= k;
  }

  h ^= length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
