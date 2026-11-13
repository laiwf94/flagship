import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testApp, type TestApp } from '../../test/app.js';
import { PASSWORD, signIn, type Client } from '../../test/session.js';
import { createLogger } from '../log.js';
import { createMetrics } from '../metrics.js';
import {
  ExperimentEventQueue,
  attributedConversions,
  experimentWriter,
  type ExperimentBatch,
} from './experimentEvents.js';

let t: TestApp;
let admin: Client;
let key: string;
let env: string;
let clock = new Date('2030-03-01T10:00:00Z');

const P = '/api/projects/default';
const MIN = 60_000;
const at = (minutes: number) => Date.parse('2030-03-01T10:00:00Z') + minutes * MIN;

const post = (body: unknown, k = key) =>
  t.app.server.inject({
    method: 'POST',
    url: '/sdk/v1/events',
    headers: { authorization: `Bearer ${k}` },
    payload: body as Record<string, unknown>,
  });

let seq = 0;
const conversion = (
  key: string,
  minutes: number,
  extra: { event?: string; value?: number; id?: string } = {},
) => ({
  id: extra.id ?? `conv-${String(++seq).padStart(6, '0')}`,
  event: extra.event ?? 'purchase',
  key,
  at: at(minutes),
  ...(extra.value === undefined ? {} : { value: extra.value }),
});

const exposures = () =>
  t.db
    .selectFrom('experiment_exposures')
    .select(['flag_key', 'context_key', 'variant', 'first_at'])
    .orderBy('flag_key')
    .orderBy('context_key')
    .execute();

beforeAll(async () => {
  t = await testApp(
    {
      bootstrapAdmin: { email: 'root@example.com', password: PASSWORD },
      eventsQueueLimit: 4,
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
  env = (
    await t.db
      .selectFrom('environments')
      .select('id')
      .where('key', '=', 'production')
      .executeTakeFirstOrThrow()
  ).id;
});
afterAll(() => t.close());

beforeEach(async () => {
  clock = new Date('2030-03-01T12:00:00Z');
  await t.app.experiments.flush();
  await t.app.exposures.flush();
  await t.db.deleteFrom('experiment_exposures').execute();
  await t.db.deleteFrom('conversion_events').execute();
});

describe('POST /sdk/v1/events with first exposures and conversions', () => {
  it('stores the first exposure per context, whatever order reports arrive in', async () => {
    const later = await post({
      exposures: [
        { flag: 'checkout', variant: 'b', key: 'u1', at: at(30) },
        { flag: 'checkout', variant: 'a', key: 'u2', at: at(5) },
      ],
    });
    expect(later.statusCode).toBe(202);
    expect(later.json()).toEqual({ accepted: 2, dropped: 0 });
    await t.app.experiments.flush();
    // Another instance (or a retry) reports an earlier exposure for u1 and a later one for u2.
    await post({
      exposures: [
        { flag: 'checkout', variant: 'a', key: 'u1', at: at(10) },
        { flag: 'checkout', variant: 'b', key: 'u2', at: at(20) },
      ],
    });
    // Within one queue, too, the earliest of two reports is the one kept.
    await post({ exposures: [{ flag: 'search', variant: 'x', key: 'u1', at: at(9) }] });
    await post({ exposures: [{ flag: 'search', variant: 'y', key: 'u1', at: at(3) }] });
    await t.app.experiments.flush();
    expect(await exposures()).toEqual([
      { flag_key: 'checkout', context_key: 'u1', variant: 'a', first_at: new Date(at(10)) },
      { flag_key: 'checkout', context_key: 'u2', variant: 'a', first_at: new Date(at(5)) },
      { flag_key: 'search', context_key: 'u1', variant: 'y', first_at: new Date(at(3)) },
    ]);
  });

  it('breaks a tie on the exposure time by variant key, so instances agree', async () => {
    await post({ exposures: [{ flag: 'tie', variant: 'b', key: 'u', at: at(1) }] });
    await t.app.experiments.flush();
    await post({ exposures: [{ flag: 'tie', variant: 'a', key: 'u', at: at(1) }] });
    await post({ exposures: [{ flag: 'tie', variant: 'c', key: 'u', at: at(1) }] });
    await t.app.experiments.flush();
    expect((await exposures()).map((r) => r.variant)).toEqual(['a']);
  });

  it('stores a conversion once however many times its batch is retried', async () => {
    const batch = {
      conversions: [
        conversion('u1', 1, { id: 'retry-0001', value: 12.5 }),
        conversion('u2', 2, { id: 'retry-0002' }),
      ],
    };
    expect((await post(batch)).statusCode).toBe(202);
    expect((await post(batch)).statusCode).toBe(202); // the answer was lost; same batch again
    await t.app.experiments.flush();
    expect((await post(batch)).statusCode).toBe(202); // and once more after it was written
    await t.app.experiments.flush();
    const rows = await t.db
      .selectFrom('conversion_events')
      .select(['id', 'event_key', 'context_key', 'value', 'occurred_at', 'received_at'])
      .orderBy('id')
      .execute();
    expect(rows).toEqual([
      {
        id: 'retry-0001',
        event_key: 'purchase',
        context_key: 'u1',
        value: 12.5,
        occurred_at: new Date(at(1)),
        received_at: clock,
      },
      {
        id: 'retry-0002',
        event_key: 'purchase',
        context_key: 'u2',
        value: null,
        occurred_at: new Date(at(2)),
        received_at: clock,
      },
    ]);
  });

  it('refuses a request whole with 429 when either queue is full, and loses nothing it took', async () => {
    const first = await post({
      exposures: [{ flag: 'bp', variant: 'a', key: 'u1', at: at(1) }],
      conversions: [conversion('u1', 2), conversion('u1', 3), conversion('u1', 4)],
    });
    expect(first.statusCode).toBe(202);
    expect(t.app.experiments.size).toBe(4);
    const countsBefore = t.app.exposures.size;
    const full = await post({
      events: [{ flag: 'bp', variant: 'a', count: 1 }],
      conversions: [conversion('u2', 5)],
    });
    expect(full.statusCode).toBe(429);
    expect(full.headers['retry-after']).toBe('5');
    // The exposure counts in the refused request were not taken either.
    expect(t.app.exposures.size).toBe(countsBefore);
    expect(t.app.metrics.experimentEvents.get({ kind: 'conversion', result: 'rejected' })).toBe(1);
    expect(t.app.metrics.exposures.get({ result: 'rejected' })).toBe(1);
    // Records already pending don't take more room, so a retry of the first batch still fits.
    expect(
      (await post({ exposures: [{ flag: 'bp', variant: 'a', key: 'u1', at: at(0) }] })).statusCode,
    ).toBe(202);
    await t.app.experiments.flush();
    expect(t.app.experiments.size).toBe(0);
    expect((await post({ conversions: [conversion('u2', 5)] })).statusCode).toBe(202);
    await t.app.experiments.flush();
    const stored = await t.db
      .selectFrom('conversion_events')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .executeTakeFirstOrThrow();
    expect(Number(stored.n)).toBe(4);
    expect((await exposures()).map((r) => r.first_at)).toEqual([new Date(at(0))]);
  });

  it('drops records with timestamps from the distant past or the future', async () => {
    const res = await post({
      exposures: [{ flag: 'old', variant: 'a', key: 'u', at: clock.getTime() - 8 * 86_400_000 }],
      conversions: [{ ...conversion('u', 0), at: clock.getTime() + 3_600_000 }, conversion('u', 0)],
    });
    expect(res.json()).toEqual({ accepted: 3, dropped: 2 });
    expect(t.app.metrics.experimentEvents.get({ kind: 'exposure', result: 'dropped' })).toBe(1);
    expect(t.app.metrics.experimentEvents.get({ kind: 'conversion', result: 'dropped' })).toBe(1);
    await t.app.experiments.flush();
    expect(await exposures()).toEqual([]);
  });

  it('accepts a beacon with the client key in the query string', async () => {
    const res = await t.app.server.inject({
      method: 'POST',
      url: `/sdk/v1/events?key=${encodeURIComponent(key)}`,
      headers: { 'content-type': 'text/plain' },
      payload: JSON.stringify({
        exposures: [{ flag: 'beacon', variant: 'a', key: 'u', at: at(1) }],
        conversions: [conversion('u', 2)],
      }),
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: 2, dropped: 0 });
  });

  it('validates every list and the total', async () => {
    const ok = conversion('u', 1);
    const bad = async (body: unknown) => (await post(body)).statusCode;
    expect(await bad({})).toBe(400);
    expect(await bad({ events: [], exposures: [], conversions: [] })).toBe(400);
    expect(await bad({ conversions: [{ ...ok, id: 'short' }] })).toBe(400);
    expect(await bad({ conversions: [{ ...ok, id: 'has spaces in it' }] })).toBe(400);
    expect(await bad({ conversions: [{ ...ok, event: '../purchase' }] })).toBe(400);
    expect(await bad({ conversions: [{ ...ok, key: '' }] })).toBe(400);
    expect(await bad({ conversions: [{ ...ok, key: 'k'.repeat(1025) }] })).toBe(400);
    expect(await bad({ conversions: [{ ...ok, value: 1e16 }] })).toBe(400);
    expect(await bad({ conversions: [{ ...ok, extra: true }] })).toBe(400);
    const { at: _at, ...noTime } = ok;
    expect(await bad({ conversions: [noTime] })).toBe(400);
    expect(await bad({ exposures: [{ flag: 'f', variant: 'a', key: 'u' }] })).toBe(400);
    const half = Array.from({ length: 501 }, (_, i) => conversion(`u${String(i)}`, 1));
    const exp = Array.from({ length: 500 }, (_, i) => ({
      flag: 'f',
      variant: 'a',
      key: `u${String(i)}`,
      at: at(1),
    }));
    expect(await bad({ conversions: half, exposures: exp })).toBe(400);
    expect((await post({ conversions: [ok] }, 'fsc_bad')).statusCode).toBe(401);
  });
});

describe('attributedConversions', () => {
  it('counts conversions for the first exposure, inside the window, and nothing else', async () => {
    const write = experimentWriter(t.db);
    await write({
      receivedAt: clock,
      exposures: [
        { environmentId: env, flag: 'exp', key: 'a1', variant: 'control', at: at(0) },
        { environmentId: env, flag: 'exp', key: 'a2', variant: 'control', at: at(0) },
        { environmentId: env, flag: 'exp', key: 'b1', variant: 'treatment', at: at(10) },
        { environmentId: env, flag: 'exp', key: 'b2', variant: 'treatment', at: at(10) },
        { environmentId: env, flag: 'other', key: 'a1', variant: 'on', at: at(0) },
      ],
      conversions: [
        // a1: two purchases inside the window, one outside it, one of another event.
        { environmentId: env, id: 'c-a1-1', event: 'purchase', key: 'a1', value: 10, at: at(5) },
        { environmentId: env, id: 'c-a1-2', event: 'purchase', key: 'a1', value: 5, at: at(50) },
        { environmentId: env, id: 'c-a1-3', event: 'purchase', key: 'a1', value: 99, at: at(70) },
        { environmentId: env, id: 'c-a1-4', event: 'signup', key: 'a1', value: null, at: at(6) },
        // b1 bought before it was exposed, then once after; b2 never bought.
        { environmentId: env, id: 'c-b1-1', event: 'purchase', key: 'b1', value: 7, at: at(9) },
        { environmentId: env, id: 'c-b1-2', event: 'purchase', key: 'b1', value: null, at: at(10) },
        // Never exposed: counts for no one.
        { environmentId: env, id: 'c-zz-1', event: 'purchase', key: 'zz', value: 1, at: at(20) },
      ],
    });
    const q = { environmentId: env, flag: 'exp', event: 'purchase', windowMs: 60 * MIN };
    expect(await attributedConversions(t.db, q)).toEqual([
      { variant: 'control', exposed: 2, converted: 1, conversions: 2, value: 15 },
      { variant: 'treatment', exposed: 2, converted: 1, conversions: 1, value: 0 },
    ]);
    expect(await attributedConversions(t.db, { ...q, windowMs: 2 * 60 * MIN })).toEqual([
      { variant: 'control', exposed: 2, converted: 1, conversions: 3, value: 114 },
      { variant: 'treatment', exposed: 2, converted: 1, conversions: 1, value: 0 },
    ]);
    expect(
      await attributedConversions(t.db, { ...q, from: new Date(at(5)), to: new Date(at(15)) }),
    ).toEqual([{ variant: 'treatment', exposed: 2, converted: 1, conversions: 1, value: 0 }]);
    expect(await attributedConversions(t.db, { ...q, flag: 'missing' })).toEqual([]);
  });

  it('keeps the earliest exposure when two instances flush overlapping rows at once', async () => {
    const write = experimentWriter(t.db);
    const keys = Array.from({ length: 300 }, (_, i) => `ctx-${String(i).padStart(3, '0')}`);
    const batch = (variant: string, minutes: number, order: 1 | -1): ExperimentBatch => ({
      receivedAt: clock,
      exposures: (order === 1 ? keys : [...keys].reverse()).map((k) => ({
        environmentId: env,
        flag: 'race',
        key: k,
        variant,
        at: at(minutes),
      })),
      conversions: keys.map((k) => ({
        environmentId: env,
        id: `race-${k}`,
        event: 'purchase',
        key: k,
        value: null,
        at: at(30),
      })),
    });
    await Promise.all([
      write(batch('late', 20, 1)),
      write(batch('early', 10, -1)),
      write(batch('late', 20, -1)),
    ]);
    expect(
      await attributedConversions(t.db, {
        environmentId: env,
        flag: 'race',
        event: 'purchase',
        windowMs: 60 * MIN,
      }),
    ).toEqual([{ variant: 'early', exposed: 300, converted: 300, conversions: 300, value: 0 }]);
  });
});

describe('ExperimentEventQueue', () => {
  it('puts records back when a flush fails and writes them once on the next', async () => {
    const written: ExperimentBatch[] = [];
    let fail = true;
    const metrics = createMetrics();
    const q = new ExperimentEventQueue({
      write: async (b) => {
        if (fail) throw new Error('database down');
        written.push(b);
      },
      limit: 10,
      flushMs: 10,
      metrics,
      logger: createLogger('silent'),
      now: () => new Date('2030-03-01T12:00:00Z'),
    });
    const p = q.prepare(
      'env',
      [{ flag: 'f', variant: 'b', key: 'u', at: at(5) }],
      [conversion('u', 6, { id: 'queued-01' })],
    );
    expect(p.fits).toBe(true);
    p.commit();
    await q.flush();
    expect(q.size).toBe(2);
    // While the first try is pending again, an earlier exposure and the same conversion arrive.
    q.prepare(
      'env',
      [{ flag: 'f', variant: 'a', key: 'u', at: at(1) }],
      [conversion('u', 6, { id: 'queued-01' })],
    ).commit();
    expect(q.size).toBe(2);
    expect(metrics.experimentQueue.render()).toContain('flagship_experiment_queue_entries 2');
    fail = false;
    q.start();
    await new Promise((r) => setTimeout(r, 50));
    await q.stop();
    expect(written.flatMap((b) => b.exposures)).toEqual([
      { environmentId: 'env', flag: 'f', key: 'u', variant: 'a', at: at(1) },
    ]);
    expect(written.flatMap((b) => b.conversions.map((c) => c.id))).toEqual(['queued-01']);
    expect(q.size).toBe(0);
  });
});
