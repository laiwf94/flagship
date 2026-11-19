import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifying flagship webhooks on the receiving side.
 *
 * Each delivery carries `Flagship-Signature: t=<unix seconds>,v1=<hex>`, with
 * one `v1` per signing secret (two for a day after a rotation). Each `v1` is
 * HMAC-SHA256, keyed with the whole secret string (`whsec_...`), over
 * `<t>.<raw body>`. A request is genuine when one `v1` matches and `t` is
 * within the tolerance of now, which keeps a captured request from being
 * replayed later.
 */

/** The header that carries the signature, lower-cased as Node presents it. */
export const SIGNATURE_HEADER = 'flagship-signature';
/** How far `t` may be from now, either way, by default: five minutes. */
export const DEFAULT_TOLERANCE_SECONDS = 300;
/** Longest header accepted; a real one is about 150 bytes per secret. */
const MAX_HEADER_LENGTH = 4096;
/** Most `v1` values checked, so a crafted header can't make verifying expensive. */
const MAX_SIGNATURES = 8;

export type WebhookSignatureErrorCode =
  | 'missing_header'
  | 'malformed_header'
  | 'timestamp_out_of_range'
  | 'no_matching_signature'
  | 'invalid_body';

/** Thrown when a request is not a genuine, recent flagship delivery. */
export class WebhookSignatureError extends Error {
  override readonly name = 'WebhookSignatureError';
  constructor(
    readonly code: WebhookSignatureErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** The JSON body of a delivery. */
export interface WebhookEvent {
  /** `evt_<n>`: the same for every webhook that gets the event, and on a replay. */
  id: string;
  /** The action, such as `flag.kill_switch`. */
  type: string;
  createdAt: string;
  project: string;
  environment: string | null;
  target: { type: string; key: string };
  actor: { id: string | null; name: string };
  reason: string | null;
  link: string | null;
  before: unknown;
  after: unknown;
  /** Set when `before` and `after` were left out to keep the payload under 256 KiB. */
  truncated?: true;
}

export interface VerifyOptions {
  /** Seconds `t` may be from now, either way; default 300. */
  toleranceSeconds?: number;
  /** The clock, for tests. */
  now?: () => Date;
}

type HeaderValue = string | readonly string[] | null | undefined;

function headerText(header: HeaderValue): string {
  if (header === null || header === undefined || header === '') {
    throw new WebhookSignatureError('missing_header', `no ${SIGNATURE_HEADER} header`);
  }
  if (typeof header !== 'string') {
    if (header.length !== 1 || header[0] === undefined) {
      throw new WebhookSignatureError(
        header.length === 0 ? 'missing_header' : 'malformed_header',
        header.length === 0
          ? `no ${SIGNATURE_HEADER} header`
          : `more than one ${SIGNATURE_HEADER} header`,
      );
    }
    return headerText(header[0]);
  }
  return header;
}

/** Splits the header into its timestamp and `v1` signatures; ignores schemes it doesn't know. */
export function parseSignatureHeader(header: HeaderValue): { t: number; v1: Buffer[] } {
  const text = headerText(header);
  if (text.length > MAX_HEADER_LENGTH) {
    throw new WebhookSignatureError('malformed_header', 'signature header too long');
  }
  let t: number | undefined;
  const v1: Buffer[] = [];
  for (const part of text.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 1) {
      throw new WebhookSignatureError('malformed_header', `malformed part "${part.trim()}"`);
    }
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') {
      if (t !== undefined || !/^\d{1,12}$/.test(value)) {
        throw new WebhookSignatureError('malformed_header', 'needs exactly one numeric t');
      }
      t = Number(value);
    } else if (key === 'v1') {
      // Not hex of the right length can't match; skip it rather than fail the others.
      if (/^[0-9a-f]{64}$/i.test(value) && v1.length < MAX_SIGNATURES) {
        v1.push(Buffer.from(value, 'hex'));
      }
    }
  }
  if (t === undefined) {
    throw new WebhookSignatureError('malformed_header', 'no timestamp (t=) in the header');
  }
  if (v1.length === 0) {
    throw new WebhookSignatureError('malformed_header', 'no v1 signature in the header');
  }
  return { t, v1 };
}

/**
 * Checks that `body` (the raw request body, exactly as received, not
 * re-serialised JSON) was signed with one of `secrets` within the tolerance.
 * Pass the old and new secrets while rotating. Throws WebhookSignatureError.
 */
export function verifyWebhookSignature(
  body: string | Uint8Array,
  header: HeaderValue,
  secrets: string | readonly string[],
  options: VerifyOptions = {},
): void {
  const keys = typeof secrets === 'string' ? [secrets] : secrets;
  if (keys.length === 0 || keys.some((k) => k === '')) {
    throw new TypeError('verifyWebhookSignature needs at least one non-empty secret');
  }
  const { t, v1 } = parseSignatureHeader(header);
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const now = Math.floor((options.now?.() ?? new Date()).getTime() / 1000);
  if (Math.abs(now - t) > tolerance) {
    throw new WebhookSignatureError(
      'timestamp_out_of_range',
      `signed at ${t}, ${now - t} seconds from now; more than ${tolerance} allowed`,
    );
  }
  let matched = false;
  for (const key of keys) {
    const expected = createHmac('sha256', key).update(`${t}.`).update(body).digest();
    // Check every candidate so the time taken says nothing about which one matched.
    for (const candidate of v1) {
      if (timingSafeEqual(expected, candidate)) matched = true;
    }
  }
  if (!matched) {
    throw new WebhookSignatureError(
      'no_matching_signature',
      'no signature matches; check the secret, and that the body is the raw one received',
    );
  }
}

/**
 * Verifies a delivery and returns its parsed body.
 *
 * ```ts
 * app.post('/flagship', express.raw({ type: 'application/json' }), (req, res) => {
 *   const event = parseWebhook(req.body, req.headers['flagship-signature'], secret);
 *   res.sendStatus(204);
 * });
 * ```
 */
export function parseWebhook(
  body: string | Uint8Array,
  header: HeaderValue,
  secrets: string | readonly string[],
  options: VerifyOptions = {},
): WebhookEvent {
  verifyWebhookSignature(body, header, secrets, options);
  const text = typeof body === 'string' ? body : Buffer.from(body).toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new WebhookSignatureError('invalid_body', 'the body is not JSON');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { id?: unknown }).id !== 'string' ||
    typeof (parsed as { type?: unknown }).type !== 'string'
  ) {
    throw new WebhookSignatureError('invalid_body', 'the body is not a flagship event');
  }
  return parsed as WebhookEvent;
}
