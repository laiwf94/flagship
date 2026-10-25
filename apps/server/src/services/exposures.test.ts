import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApp, type TestApp } from '../../test/app.js';
import { PASSWORD, signIn, type Client } from '../../test/session.js';
import { createLogger } from '../log.js';
import { createMetrics } from '../metrics.js';
import { ExposureQueue, type ExposureRow } from './exposures.js';

let t: TestApp;
let admin: Client;
let key: string;
let clock = new Date('2030-03-01T10:59:00Z');

const P = '/api/projects/default';

const post = (events: unknown[], k = key) =>
  t.app.server.inject({
    method: 'POST',
    url: '/sdk/v1/events',
    headers: { authorization: `Bearer ${k}` },
    payload: { events },
  });

beforeAll(async () => {
  t = await testApp(
    {
      bootstrapAdmin: { email: 'root@example.com', password: PASSWORD },
      eventsQueueLimit: 3,
      eventsFlushMs: 3_600_000,
    },
    { now: () => clock },
  );
  admin = await signIn(t.app.server, 'root@example.com');
  key = (
    await admin.request('POST', `${P}/environments/production/api-keys`, {
      kind: 'client',
      name: 'web',
    })
  ).json().secret;
});
afterAll(() => t.close());

describe('POST /sdk/v1/events', () => {
  it('accepts counts, refuses a batch that would overflow the queue, and loses nothing it accepted', async () => {
    const first = await post([
      { flag: 'checkout', variant: 'on', count: 7 },
      { flag: 'checkout', variant: 'off', count: 3 },
    ]);
    expect(first.statusCode).toBe(202);
    expect(first.json()).toEqual({ accepted: 2, dropped: 0 });
    const same = await post([{ flag: 'checkout', variant: 'on', count: 5 }]);
    expect(same.statusCode).toBe(202);
    const overflow = await post([
      { flag: 'search', variant: 'a', count: 1 },
      { flag: 'search', variant: 'b', count: 1 },
    ]);
    expect(overflow.statusCode).toBe(429);
    expect(overflow.headers['retry-after']).toBe('5');
    expect(t.app.exposures.size).toBe(2);

    await t.app.exposures.flush();
    expect(t.app.exposures.size).toBe(0);
    const retry = await post([
      { flag: 'search', variant: 'a', count: 1 },
      { flag: 'search', variant: 'b', count: 1 },
    ]);
    expect(retry.statusCode).toBe(202);
    await t.app.exposures.flush();

    const summary = (
      await admin.request('GET', `${P}/flags/checkout/exposures?environment=production&hours=2`)
    ).json();
    expect(summary.totals).toEqual([
      { variant: 'on', count: 12 },
      { variant: 'off', count: 3 },
    ]);
    expect(summary.series).toHaveLength(2);
    expect(summary.series[1]).toEqual({
      hour: '2030-03-01T10:00:00.000Z',
      counts: { on: 12, off: 3 },
    });
  });

  it('buckets by hour and sums across the boundary', async () => {
    await post([{ flag: 'hourly', variant: 'on', count: 2 }]);
    clock = new Date('2030-03-01T11:01:00Z');
    await post([
      { flag: 'hourly', variant: 'on', count: 3 },
      { flag: 'hourly', variant: 'on', count: 4, at: Date.parse('2030-03-01T10:30:00Z') },
    ]);
    await t.app.exposures.flush();
    const summary = (
      await admin.request('GET', `${P}/flags/hourly/exposures?environment=production&hours=3`)
    ).json();
    expect(summary.totals).toEqual([{ variant: 'on', count: 9 }]);
    expect(summary.series.map((s: { counts: { on?: number } }) => s.counts.on ?? 0)).toEqual([
      0, 6, 3,
    ]);
  });

  it('drops events with timestamps from the distant past or the future', async () => {
    const res = await post([
      { flag: 'old', variant: 'on', count: 5, at: clock.getTime() - 8 * 86_400_000 },
      { flag: 'old', variant: 'on', count: 2, at: clock.getTime() + 3_600_000 },
    ]);
    expect(res.json()).toEqual({ accepted: 2, dropped: 7 });
    expect(t.app.metrics.exposures.get({ result: 'dropped' })).toBe(7);
  });

  it('validates batches', async () => {
    expect((await post([])).statusCode).toBe(400);
    expect((await post([{ flag: 'x', variant: 'on', count: 0 }])).statusCode).toBe(400);
    expect((await post([{ flag: '../x', variant: 'on', count: 1 }])).statusCode).toBe(400);
    const many = Array.from({ length: 1001 }, () => ({ flag: 'x', variant: 'on', count: 1 }));
    expect((await post(many)).statusCode).toBe(400);
    expect((await post([{ flag: 'x', variant: 'on', count: 1 }], 'fsc_bad')).statusCode).toBe(401);
    const query = await admin.request(
      'GET',
      `${P}/flags/x/exposures?environment=production&hours=0`,
    );
    expect(query.statusCode).toBe(400);
  });
});

describe('ExposureQueue', () => {
  it('puts rows back when a flush fails and writes them on the next one', async () => {
    const written: ExposureRow[][] = [];
    let fail = true;
    const q = new ExposureQueue({
      write: async (rows) => {
        if (fail) throw new Error('database down');
        written.push(rows);
      },
      limit: 10,
      flushMs: 10,
      metrics: createMetrics(),
      logger: createLogger('silent'),
      now: () => new Date('2030-01-01T00:00:00Z'),
    });
    q.offer('env', [{ flag: 'f', variant: 'on', count: 2 }]);
    await q.flush();
    expect(q.size).toBe(1);
    q.offer('env', [{ flag: 'f', variant: 'on', count: 3 }]);
    fail = false;
    q.start();
    await new Promise((r) => setTimeout(r, 50));
    await q.stop();
    expect(written.flat()).toEqual([
      expect.objectContaining({ flag: 'f', variant: 'on', count: 5 }),
    ]);
    expect(q.size).toBe(0);
  });
});
