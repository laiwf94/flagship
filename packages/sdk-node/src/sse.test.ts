import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SseParser } from './sse.js';

describe('SseParser', () => {
  it('parses events, ids, multi-line data, comments and retry', () => {
    const p = new SseParser();
    const out = p.feed(
      ': hello\nretry: 2000\nid: 7\nevent: put\ndata: {"a":\ndata: 1}\n\ndata: plain\n\n',
    );
    expect(out).toEqual([
      { event: 'put', data: '{"a":\n1}', id: '7' },
      { event: 'message', data: 'plain', id: '7' },
    ]);
    expect(p.retryMs).toBe(2000);
    expect(p.lastEventId).toBe('7');
  });

  it('handles CR and CRLF endings and fields without a space or value', () => {
    const p = new SseParser();
    expect(p.feed('event:x\r\ndata:1\r\n\r\nevent: y\rdata\r\r\n')).toEqual([
      { event: 'x', data: '1', id: undefined },
      { event: 'y', data: '', id: undefined },
    ]);
  });

  it('ignores ids containing NUL, unknown fields, bad retry and empty dispatches', () => {
    const p = new SseParser();
    expect(p.feed('id: a\u0000b\nretry: soon\nfoo: bar\nevent: lonely\n\n')).toEqual([]);
    expect(p.lastEventId).toBeUndefined();
    expect(p.retryMs).toBeUndefined();
  });

  it('produces the same events however the stream is split into chunks', () => {
    const text =
      'id: 1\nevent: put\ndata: {"x":1}\n\n: ping\r\n\r\nid: 2\r\nevent: patch\r\ndata: a\r\ndata: b\r\n\r\n';
    const whole = new SseParser().feed(text);
    fc.assert(
      fc.property(fc.array(fc.nat(text.length), { maxLength: 10 }), (cuts) => {
        const points = [0, ...cuts.sort((a, b) => a - b), text.length];
        const p = new SseParser();
        const got = points.slice(1).flatMap((end, i) => p.feed(text.slice(points[i], end)));
        expect(got).toEqual(whole);
      }),
    );
  });
});
