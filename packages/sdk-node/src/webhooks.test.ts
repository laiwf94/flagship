import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOLERANCE_SECONDS,
  parseSignatureHeader,
  parseWebhook,
  verifyWebhookSignature,
  WebhookSignatureError,
  type WebhookSignatureErrorCode,
} from './index.js';

const SECRET = 'whsec_current';
const OLD = 'whsec_previous';
const NOW = new Date('2030-03-01T12:00:00Z');
const T = Math.floor(NOW.getTime() / 1000);
const now = () => NOW;
const BODY = JSON.stringify({
  id: 'evt_42',
  type: 'flag.kill_switch',
  createdAt: NOW.toISOString(),
  project: 'default',
  environment: 'production',
  target: { type: 'flag', key: 'checkout' },
  actor: { id: null, name: 'Ada' },
  reason: 'incident',
  link: null,
  before: { killed: false },
  after: { killed: true },
  note: 'ünïcødé',
});

const sign = (secret: string, t: number, body: string | Buffer) =>
  createHmac('sha256', secret).update(`${t}.`).update(body).digest('hex');
const header = (t: number, ...secrets: string[]) =>
  [`t=${t}`, ...secrets.map((s) => `v1=${sign(s, t, BODY)}`)].join(',');

function code(fn: () => unknown): WebhookSignatureErrorCode | 'no error' {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(WebhookSignatureError);
    return (err as WebhookSignatureError).code;
  }
  return 'no error';
}

describe('verifying webhook signatures', () => {
  it('accepts a genuine, recent request as a string or the raw bytes', () => {
    expect(
      code(() => {
        verifyWebhookSignature(BODY, header(T, SECRET), SECRET, { now });
      }),
    ).toBe('no error');
    expect(
      code(() => {
        verifyWebhookSignature(Buffer.from(BODY), header(T, SECRET), SECRET, { now });
      }),
    ).toBe('no error');
    expect(
      code(() => {
        verifyWebhookSignature(new Uint8Array(Buffer.from(BODY)), [header(T, SECRET)], SECRET, {
          now,
        });
      }),
    ).toBe('no error');
    const event = parseWebhook(BODY, header(T, SECRET), SECRET, { now });
    expect(event).toMatchObject({
      id: 'evt_42',
      type: 'flag.kill_switch',
      after: { killed: true },
    });
  });

  it('accepts either secret during a rotation, in either order', () => {
    const both = header(T, SECRET, OLD);
    expect(
      code(() => {
        verifyWebhookSignature(BODY, both, SECRET, { now });
      }),
    ).toBe('no error');
    expect(
      code(() => {
        verifyWebhookSignature(BODY, both, OLD, { now });
      }),
    ).toBe('no error');
    // A receiver that already has the new secret, while the sender still signs with the old.
    expect(
      code(() => {
        verifyWebhookSignature(BODY, header(T, OLD), [SECRET, OLD], { now });
      }),
    ).toBe('no error');
  });

  it('refuses a wrong secret, a changed body and a re-serialised body', () => {
    expect(
      code(() => {
        verifyWebhookSignature(BODY, header(T, SECRET), 'whsec_other', { now });
      }),
    ).toBe('no_matching_signature');
    const changed = BODY.replace('"killed":true', '"killed":false');
    expect(
      code(() => {
        verifyWebhookSignature(changed, header(T, SECRET), SECRET, { now });
      }),
    ).toBe('no_matching_signature');
    const pretty = JSON.stringify(JSON.parse(BODY), null, 2);
    expect(
      code(() => {
        verifyWebhookSignature(pretty, header(T, SECRET), SECRET, { now });
      }),
    ).toBe('no_matching_signature');
    // A signature for another timestamp doesn't carry over.
    const moved = `t=${T + 1},v1=${sign(SECRET, T, BODY)}`;
    expect(
      code(() => {
        verifyWebhookSignature(BODY, moved, SECRET, { now });
      }),
    ).toBe('no_matching_signature');
  });

  it('refuses timestamps outside the tolerance, either way', () => {
    const at = (t: number, toleranceSeconds?: number) =>
      code(() => {
        verifyWebhookSignature(BODY, header(t, SECRET), SECRET, {
          now,
          ...(toleranceSeconds === undefined ? {} : { toleranceSeconds }),
        });
      });
    expect(at(T - DEFAULT_TOLERANCE_SECONDS)).toBe('no error');
    expect(at(T + DEFAULT_TOLERANCE_SECONDS)).toBe('no error');
    expect(at(T - DEFAULT_TOLERANCE_SECONDS - 1)).toBe('timestamp_out_of_range');
    expect(at(T + DEFAULT_TOLERANCE_SECONDS + 1)).toBe('timestamp_out_of_range');
    expect(at(T - 3600, 3600)).toBe('no error');
    expect(at(T - 1, 0)).toBe('timestamp_out_of_range');
    // The default clock is the real one: a 2030 timestamp is far off today.
    expect(
      code(() => {
        verifyWebhookSignature(BODY, header(T, SECRET), SECRET);
      }),
    ).toBe('timestamp_out_of_range');
  });

  it('refuses missing and malformed headers', () => {
    const good = sign(SECRET, T, BODY);
    const cases: [Parameters<typeof verifyWebhookSignature>[1], WebhookSignatureErrorCode][] = [
      [undefined, 'missing_header'],
      [null, 'missing_header'],
      ['', 'missing_header'],
      [[], 'missing_header'],
      [[header(T, SECRET), header(T, SECRET)], 'malformed_header'],
      [`v1=${good}`, 'malformed_header'],
      [`t=${T}`, 'malformed_header'],
      [`t=${T},t=${T},v1=${good}`, 'malformed_header'],
      [`t=soon,v1=${good}`, 'malformed_header'],
      [`t=-${T},v1=${good}`, 'malformed_header'],
      [`t=${T},v1=${good},`, 'malformed_header'],
      [`t=${T},=x,v1=${good}`, 'malformed_header'],
      [`t=${T},v1=nothex`, 'malformed_header'],
      [`t=${T},v1=${good}${'x'.repeat(5000)}`, 'malformed_header'],
    ];
    for (const [h, expected] of cases) {
      expect(
        code(() => {
          verifyWebhookSignature(BODY, h, SECRET, { now });
        }),
        String(h),
      ).toBe(expected);
    }
  });

  it('skips signature schemes and values it does not know, and tolerates spaces', () => {
    const good = sign(SECRET, T, BODY);
    expect(
      code(() => {
        verifyWebhookSignature(
          BODY,
          ` t=${T} , v0=abc, v1=${'0'.repeat(64)}, v1=${good.toUpperCase()}`,
          SECRET,
          {
            now,
          },
        );
      }),
    ).toBe('no error');
    expect(parseSignatureHeader(`t=${T},v2=x,v1=${good},v1=short`)).toEqual({
      t: T,
      v1: [Buffer.from(good, 'hex')],
    });
    // At most eight signatures are checked.
    const many = [
      `t=${T}`,
      ...Array.from({ length: 8 }, () => `v1=${'0'.repeat(64)}`),
      `v1=${good}`,
    ];
    expect(
      code(() => {
        verifyWebhookSignature(BODY, many.join(','), SECRET, { now });
      }),
    ).toBe('no_matching_signature');
  });

  it('needs a secret', () => {
    expect(() => {
      verifyWebhookSignature(BODY, header(T, SECRET), [], { now });
    }).toThrow(TypeError);
    expect(() => {
      verifyWebhookSignature(BODY, header(T, SECRET), '', { now });
    }).toThrow(TypeError);
  });

  it('parses only signed JSON that looks like an event', () => {
    const signed = (body: string) => `t=${T},v1=${sign(SECRET, T, body)}`;
    for (const body of ['not json', '[]', 'null', '{"id":1,"type":"x"}', '{"id":"evt_1"}']) {
      expect(
        code(() => parseWebhook(body, signed(body), SECRET, { now })),
        body,
      ).toBe('invalid_body');
    }
    const bytes = Buffer.from(BODY);
    expect(parseWebhook(bytes, signed(BODY), SECRET, { now }).id).toBe('evt_42');
    const err = (() => {
      try {
        parseWebhook(BODY, signed('other'), SECRET, { now });
      } catch (e) {
        return e as WebhookSignatureError;
      }
      return null;
    })();
    expect(err?.name).toBe('WebhookSignatureError');
    expect(err?.message).toMatch(/raw one received/);
  });
});
