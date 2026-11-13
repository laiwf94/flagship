import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testApp, type TestApp } from '../../test/app.js';
import { PASSWORD } from '../../test/session.js';
import { createDatabase, type Db } from '../db/database.js';
import { createLogger } from '../log.js';
import { createMetrics } from '../metrics.js';
import {
  attributedConversions,
  experimentWriter,
  type ConversionRecord,
  type ExposureRecord,
} from './experimentEvents.js';
import {
  ATTRIBUTION_WINDOW_MS,
  cohortHour,
  experimentRollup,
  resolvePendingConversions,
  rollUpNext,
  rolledUpConversions,
  rollupBacklog,
} from './experimentRollup.js';

let t: TestApp;
let other: Db;
let env: string;

const MIN = 60_000;
const T0 = Date.parse('2030-03-01T10:00:00Z');
const at = (minutes: number) => T0 + minutes * MIN;

const quiet = createLogger('silent');

function job(db: Db, metrics = createMetrics()) {
  return experimentRollup({ db, metrics, logger: quiet });
}

let seq = 0;
function exposure(flag: string, key: string, variant: string, minutes: number): ExposureRecord {
  return { environmentId: env, flag, key, variant, at: at(minutes) };
}
function conversion(
  key: string,
  minutes: number,
  extra: { event?: string; value?: number; id?: string } = {},
): ConversionRecord {
  return {
    environmentId: env,
    id: extra.id ?? `c-${String(++seq).padStart(8, '0')}`,
    event: extra.event ?? 'purchase',
    key,
    value: extra.value ?? null,
    at: at(minutes),
  };
}

async function write(
  db: Db,
  b: { exposures?: ExposureRecord[]; conversions?: ConversionRecord[] },
): Promise<void> {
  await experimentWriter(db)({
    exposures: b.exposures ?? [],
    conversions: b.conversions ?? [],
    receivedAt: new Date(T0),
  });
}

async function drain(db: Db = t.db): Promise<number> {
  let total = 0;
  for (;;) {
    const n = await job(db)();
    total += n;
    const left = await rollupBacklog(db);
    if (left.hours === 0 && left.contexts === 0) return total;
  }
}

async function rollupRows() {
  const exposures = await t.db
    .selectFrom('experiment_rollup_exposures')
    .select(['flag_key', 'hour', 'variant', 'contexts'])
    .orderBy('flag_key')
    .orderBy('hour')
    .orderBy('variant')
    .execute();
  const conversions = await t.db
    .selectFrom('experiment_rollup_conversions')
    .select([
      'flag_key',
      'event_key',
      'hour',
      'variant',
      'converted',
      'conversions',
      'value_sum',
      'value_squares',
      'conversion_squares',
    ])
    .orderBy('flag_key')
    .orderBy('event_key')
    .orderBy('hour')
    .orderBy('variant')
    .execute();
  return { exposures, conversions };
}

beforeAll(async () => {
  t = await testApp(
    {
      bootstrapAdmin: { email: 'root@example.com', password: PASSWORD },
      schedulerIntervalMs: 3_600_000,
      eventsFlushMs: 3_600_000,
    },
    { now: () => new Date(T0) },
  );
  other = createDatabase({ url: t.url, maxConnections: 4 }).db;
  env = (
    await t.db
      .selectFrom('environments')
      .select('id')
      .where('key', '=', 'production')
      .executeTakeFirstOrThrow()
  ).id;
});
afterAll(async () => {
  await other.destroy();
  await t.close();
});

beforeEach(async () => {
  for (const table of [
    'experiment_exposures',
    'conversion_events',
    'experiment_rollup_dirty',
    'experiment_rollup_pending',
    'experiment_rollup_exposures',
    'experiment_rollup_conversions',
  ] as const) {
    await t.db.deleteFrom(table).execute();
  }
});

describe('hourly experiment rollup', () => {
  it('rolls up per cohort hour and variant, with per-context squares', async () => {
    await write(t.db, {
      exposures: [
        exposure('checkout', 'u1', 'a', 5),
        exposure('checkout', 'u2', 'a', 30),
        exposure('checkout', 'u3', 'b', 59),
        exposure('checkout', 'u4', 'b', 61), // the next hour
        exposure('checkout', 'u5', 'a', 70),
      ],
      conversions: [
        conversion('u1', 6, { value: 10 }),
        conversion('u1', 50, { value: 5 }),
        conversion('u2', 31),
        conversion('u3', 120, { value: 7 }),
        conversion('u3', 121, { event: 'signup' }),
        conversion('u4', 62, { value: 3 }),
        conversion('nobody', 62, { value: 100 }), // never exposed
      ],
    });
    expect(await rollupBacklog(t.db)).toEqual({ hours: 2, contexts: 5 });
    expect(await drain()).toBe(2);

    const h10 = new Date(at(0));
    const h11 = new Date(at(60));
    const { exposures, conversions } = await rollupRows();
    expect(exposures).toEqual([
      { flag_key: 'checkout', hour: h10, variant: 'a', contexts: 2 },
      { flag_key: 'checkout', hour: h10, variant: 'b', contexts: 1 },
      { flag_key: 'checkout', hour: h11, variant: 'a', contexts: 1 },
      { flag_key: 'checkout', hour: h11, variant: 'b', contexts: 1 },
    ]);
    const row = (event: string, hour: Date, variant: string, n: number[], v: number[]) => ({
      flag_key: 'checkout',
      event_key: event,
      hour,
      variant,
      converted: n.length,
      conversions: n.reduce((s, x) => s + x, 0),
      value_sum: v.reduce((s, x) => s + x, 0),
      value_squares: v.reduce((s, x) => s + x * x, 0),
      conversion_squares: n.reduce((s, x) => s + x * x, 0),
    });
    expect(conversions).toEqual([
      // u1 converted twice for 15 in all, u2 once with no value.
      row('purchase', h10, 'a', [2, 1], [15, 0]),
      row('purchase', h10, 'b', [1], [7]),
      row('purchase', h11, 'b', [1], [3]),
      row('signup', h10, 'b', [1], [0]),
    ]);

    // The read side sums the hours and lists exposed variants without conversions as zeros.
    const q = { environmentId: env, flag: 'checkout', event: 'purchase' };
    expect(await rolledUpConversions(t.db, q)).toEqual([
      {
        variant: 'a',
        exposed: 3,
        converted: 2,
        conversions: 3,
        value: 15,
        valueSquares: 225,
        conversionSquares: 5,
      },
      {
        variant: 'b',
        exposed: 2,
        converted: 2,
        conversions: 2,
        value: 10,
        valueSquares: 58,
        conversionSquares: 2,
      },
    ]);
    // And agrees with attributing straight from the raw tables.
    const raw = await attributedConversions(t.db, { ...q, windowMs: ATTRIBUTION_WINDOW_MS });
    expect(
      (await rolledUpConversions(t.db, q)).map(
        ({ variant, exposed, converted, conversions, value }) => ({
          variant,
          exposed,
          converted,
          conversions,
          value,
        }),
      ),
    ).toEqual(raw);

    // Ranges are whole cohort hours; a bound inside an hour takes the hour it falls in.
    const only11 = await rolledUpConversions(t.db, { ...q, from: new Date(at(60)) });
    expect(only11.map((r) => [r.variant, r.exposed, r.converted])).toEqual([
      ['a', 1, 0],
      ['b', 1, 1],
    ]);
    const only10 = await rolledUpConversions(t.db, { ...q, to: new Date(at(30)) });
    expect(only10.map((r) => [r.variant, r.exposed, r.converted])).toEqual([
      ['a', 2, 2],
      ['b', 1, 1],
    ]);
    expect(await rolledUpConversions(t.db, { ...q, from: h11, to: h11 })).toEqual([]);
    expect(await rolledUpConversions(t.db, { ...q, event: 'refund' })).toEqual([
      expect.objectContaining({ variant: 'a', exposed: 3, converted: 0, value: 0 }),
      expect.objectContaining({ variant: 'b', exposed: 2, converted: 0, value: 0 }),
    ]);
  });

  it('counts conversions inside the window only, at the exposure and up to 7 days after', async () => {
    const week = ATTRIBUTION_WINDOW_MS / MIN;
    await write(t.db, {
      exposures: [exposure('f', 'u', 'a', 10)],
      conversions: [
        conversion('u', 9), // before the exposure
        conversion('u', 10), // at it
        conversion('u', 10 + week - 1),
        conversion('u', 10 + week), // the window is half-open
      ],
    });
    await drain();
    const [r] = await rolledUpConversions(t.db, {
      environmentId: env,
      flag: 'f',
      event: 'purchase',
    });
    expect(r).toMatchObject({ exposed: 1, converted: 1, conversions: 2, conversionSquares: 4 });
  });

  it('picks up conversions reported before the exposure, and late ones, when they arrive', async () => {
    const q = { environmentId: env, flag: 'f', event: 'purchase' };
    // The conversion arrives first: nothing to attribute it to yet.
    await write(t.db, { conversions: [conversion('u', 20, { value: 4 })] });
    expect(await drain()).toBe(0);
    expect(await rolledUpConversions(t.db, q)).toEqual([]);
    // The exposure report, from a slower instance, marks its hour.
    await write(t.db, { exposures: [exposure('f', 'u', 'a', 15)] });
    await drain();
    expect((await rolledUpConversions(t.db, q))[0]).toMatchObject({ converted: 1, value: 4 });
    // A conversion days later, still inside the window, re-marks the cohort hour.
    await write(t.db, { conversions: [conversion('u', 3 * 24 * 60, { value: 6, id: 'late-1' })] });
    expect(await rollupBacklog(t.db)).toEqual({ hours: 0, contexts: 1 });
    expect(await drain()).toBe(1);
    expect((await rolledUpConversions(t.db, q))[0]).toMatchObject({
      converted: 1,
      conversions: 2,
      value: 10,
      valueSquares: 100,
    });
    // A retried batch inserts nothing, so it marks nothing.
    await write(t.db, { conversions: [conversion('u', 3 * 24 * 60, { value: 6, id: 'late-1' })] });
    expect(await rollupBacklog(t.db)).toEqual({ hours: 0, contexts: 0 });
  });

  it('recomputes the hour an exposure leaves when an earlier report moves it', async () => {
    await write(t.db, {
      exposures: [exposure('f', 'u', 'b', 130), exposure('f', 'v', 'b', 125)],
      conversions: [conversion('u', 140)],
    });
    await drain();
    await write(t.db, { exposures: [exposure('f', 'u', 'a', 20)] }); // an earlier first exposure
    // Both the hour it enters and the one it leaves are marked.
    const marked = await t.db
      .selectFrom('experiment_rollup_dirty')
      .select('hour')
      .orderBy('hour')
      .execute();
    expect(marked.map((m) => m.hour)).toEqual([new Date(at(0)), new Date(at(120))]);
    await drain();
    const { exposures, conversions } = await rollupRows();
    expect(exposures.map((r) => [r.hour, r.variant, r.contexts])).toEqual([
      [new Date(at(0)), 'a', 1],
      [new Date(at(120)), 'b', 1],
    ]);
    expect(conversions.map((r) => [r.hour, r.variant, r.converted])).toEqual([
      [new Date(at(0)), 'a', 1],
    ]);
    // A later report for u changes nothing and marks nothing.
    await write(t.db, { exposures: [exposure('f', 'u', 'b', 200)] });
    expect(await rollupBacklog(t.db)).toEqual({ hours: 0, contexts: 0 });
  });

  it('writes the same rows when a slice is rolled up again', async () => {
    await write(t.db, {
      exposures: [exposure('f', 'u1', 'a', 1), exposure('f', 'u2', 'b', 61)],
      conversions: [conversion('u1', 2, { value: 1.5 }), conversion('u2', 70, { value: 2.25 })],
    });
    await drain();
    const before = await rollupRows();
    // Mark every hour again, as a replayed write or a stale instance would.
    await sql`
      INSERT INTO experiment_rollup_dirty (environment_id, flag_key, hour)
      SELECT environment_id, flag_key, hour FROM experiment_rollup_exposures
    `.execute(t.db);
    expect(await drain(other)).toBe(2);
    expect(await rollupRows()).toEqual(before);
    // With nothing marked, a turn does nothing.
    expect(await job(t.db)()).toBe(0);
    expect(await rollupRows()).toEqual(before);
  });

  it('removes an hour whose exposures all moved away', async () => {
    await write(t.db, { exposures: [exposure('f', 'u', 'a', 70)] });
    await drain();
    await write(t.db, { exposures: [exposure('f', 'u', 'a', 10)] });
    await drain();
    expect((await rollupRows()).exposures.map((r) => r.hour)).toEqual([new Date(at(0))]);
  });

  it('keeps flags and environments apart', async () => {
    const staging = (
      await t.db
        .selectFrom('environments')
        .select('id')
        .where('key', '=', 'development')
        .executeTakeFirstOrThrow()
    ).id;
    await write(t.db, {
      exposures: [
        exposure('f', 'u', 'a', 1),
        exposure('g', 'u', 'x', 2),
        { environmentId: staging, flag: 'f', key: 'u', variant: 'b', at: at(1) },
      ],
      conversions: [conversion('u', 3)],
    });
    await drain();
    const q = { flag: 'f', event: 'purchase' };
    expect(await rolledUpConversions(t.db, { ...q, environmentId: env })).toEqual([
      expect.objectContaining({ variant: 'a', exposed: 1, converted: 1 }),
    ]);
    // The conversion was reported in production; development's exposure has none.
    expect(await rolledUpConversions(t.db, { ...q, environmentId: staging })).toEqual([
      expect.objectContaining({ variant: 'b', exposed: 1, converted: 0 }),
    ]);
    expect(await rolledUpConversions(t.db, { ...q, flag: 'g', environmentId: env })).toEqual([
      expect.objectContaining({ variant: 'x', exposed: 1, converted: 1 }),
    ]);
  });

  it('yields an hour another instance holds, and a stale one, leaving the marks for later', async () => {
    await write(t.db, { exposures: [exposure('f', 'u', 'a', 1)] });
    await write(t.db, { exposures: [exposure('f', 'v', 'a', 2)] });
    const hour = new Date(at(0));
    const lockKey = `experiment_rollup|${env}|${hour.toISOString()}|f`;

    // Another instance holds the hour's lock.
    const held = await other.connection().execute(async (conn) => {
      await sql`BEGIN`.execute(conn);
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`.execute(conn);
      const r = await rollUpNext(t.db);
      await sql`ROLLBACK`.execute(conn);
      return r;
    });
    expect(held).toMatchObject({ outcome: 'busy', slice: { flag: 'f', hour } });
    expect(await rollupBacklog(t.db)).toEqual({ hours: 2, contexts: 0 });

    // Another instance has one of the hour's marks and finishes after this one looked.
    const metrics = createMetrics();
    const conflict = await other.connection().execute(async (conn) => {
      await sql`BEGIN`.execute(conn);
      const first = await sql<{ id: number }>`
        SELECT id FROM experiment_rollup_dirty ORDER BY id LIMIT 1 FOR UPDATE
      `.execute(conn);
      const pending = experimentRollup({ db: t.db, metrics, logger: quiet })();
      // Let the rollup take the next mark and block on the held one.
      for (let i = 0; i < 100; i++) {
        const waiting = await sql<{ n: number }>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND datname = current_database()
        `.execute(t.db);
        if ((waiting.rows[0]?.n ?? 0) > 0) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      await sql`DELETE FROM experiment_rollup_dirty WHERE id = ${first.rows[0]?.id}`.execute(conn);
      await sql`COMMIT`.execute(conn);
      return pending;
    });
    expect(conflict).toBe(0);
    expect(metrics.registry.render()).toContain(
      'flagship_experiment_rollups_total{result="conflict"} 1',
    );
    expect(await rollupBacklog(t.db)).toEqual({ hours: 1, contexts: 0 });
    expect(await drain()).toBe(1);
    expect((await rollupRows()).exposures).toEqual([
      { flag_key: 'f', hour, variant: 'a', contexts: 2 },
    ]);
  });

  it('resolves pending conversions in batches', async () => {
    await write(t.db, {
      exposures: [exposure('f', 'a', 'x', 1), exposure('f', 'b', 'x', 61)],
      conversions: [conversion('a', 2), conversion('b', 62), conversion('c', 63)],
    });
    await t.db.deleteFrom('experiment_rollup_dirty').execute();
    expect(await resolvePendingConversions(t.db, 2)).toBe(2);
    expect(await resolvePendingConversions(t.db, 2)).toBe(1);
    expect(await resolvePendingConversions(t.db, 2)).toBe(0);
    // Two contexts with exposures, one hour each; the third was never exposed.
    expect(await rollupBacklog(t.db)).toEqual({ hours: 2, contexts: 0 });
  });

  it('runs from the scheduler loop and reports what it did', async () => {
    await write(t.db, {
      exposures: [exposure('f', 'u', 'a', 1)],
      conversions: [conversion('u', 2)],
    });
    await t.app.scheduler.housekeep();
    expect(await rollupBacklog(t.db)).toEqual({ hours: 0, contexts: 0 });
    expect(t.app.metrics.registry.render()).toContain(
      'flagship_experiment_rollups_total{result="rolled_up"} 1',
    );
  });

  it('matches a direct computation when two instances race writers over many hours', async () => {
    // A small deterministic generator, so a failure replays.
    let state = 0x2545f491;
    const rand = (n: number) => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) % n;
    };
    const earlier = (a: { at: number; variant: string }, b: { at: number; variant: string }) =>
      a.at < b.at || (a.at === b.at && a.variant < b.variant);
    const flags = ['f', 'g'];
    const variants = ['a', 'b', 'c'];
    const events = ['purchase', 'signup'];
    const first = new Map<string, { variant: string; at: number }>();
    const conversions: ConversionRecord[] = [];
    const batches: { exposures: ExposureRecord[]; conversions: ConversionRecord[] }[] = [];
    for (let b = 0; b < 30; b++) {
      // One record per flag and context in a batch, as the queue sends them.
      const ex = new Map<string, ExposureRecord>();
      const cv: ConversionRecord[] = [];
      for (let i = 0; i < 40; i++) {
        const flag = flags[rand(flags.length)] as string;
        const key = `u${rand(150)}`;
        const r = exposure(flag, key, variants[rand(3)] as string, rand(48 * 60));
        const k = `${flag}\u0000${key}`;
        const inBatch = ex.get(k);
        if (inBatch !== undefined && !earlier(r, inBatch)) continue;
        ex.set(k, r);
        const seen = first.get(k);
        if (seen === undefined || earlier(r, seen)) first.set(k, { variant: r.variant, at: r.at });
      }
      for (let i = 0; i < 30; i++) {
        const c = conversion(`u${rand(150)}`, rand(10 * 24 * 60), {
          event: events[rand(2)] as string,
          ...(rand(3) === 0 ? {} : { value: rand(50) }),
        });
        cv.push(c);
        conversions.push(c);
      }
      batches.push({ exposures: [...ex.values()], conversions: cv });
    }

    // Writers on both pools and two rollup workers, all at once.
    let writing = true;
    const writers = Promise.all([
      (async () => {
        for (const b of batches.filter((_, i) => i % 2 === 0)) await write(t.db, b);
      })(),
      (async () => {
        for (const b of batches.filter((_, i) => i % 2 === 1)) await write(other, b);
      })(),
    ]).finally(() => {
      writing = false;
    });
    const worker = async (db: Db) => {
      const run = job(db);
      while (writing) await run();
    };
    await Promise.all([writers, worker(t.db), worker(other)]);
    await Promise.all([drain(t.db), drain(other)]);

    // Expected rows, computed here from the same records.
    const expExposures = new Map<string, number>();
    const perContext = new Map<string, { n: number; v: number }>();
    for (const [k, f] of first) {
      const [flag, key] = k.split('\u0000') as [string, string];
      const hour = cohortHour(f.at).toISOString();
      const ek = `${flag}|${hour}|${f.variant}`;
      expExposures.set(ek, (expExposures.get(ek) ?? 0) + 1);
      for (const c of conversions) {
        if (c.key !== key || c.at < f.at || c.at >= f.at + ATTRIBUTION_WINDOW_MS) continue;
        const ck = `${flag}|${c.event}|${hour}|${f.variant}|${key}`;
        const p = perContext.get(ck) ?? { n: 0, v: 0 };
        p.n++;
        p.v += c.value ?? 0;
        perContext.set(ck, p);
      }
    }
    const expConversions = new Map<string, number[]>();
    for (const [k, p] of perContext) {
      const rk = k.split('|').slice(0, 4).join('|');
      const s = expConversions.get(rk) ?? [0, 0, 0, 0, 0];
      s[0]! += 1;
      s[1]! += p.n;
      s[2]! += p.v;
      s[3]! += p.v * p.v;
      s[4]! += p.n * p.n;
      expConversions.set(rk, s);
    }

    const rows = await rollupRows();
    expect(
      new Map(
        rows.exposures.map((r) => [
          `${r.flag_key}|${r.hour.toISOString()}|${r.variant}`,
          r.contexts,
        ]),
      ),
    ).toEqual(expExposures);
    expect(
      new Map(
        rows.conversions.map((r) => [
          `${r.flag_key}|${r.event_key}|${r.hour.toISOString()}|${r.variant}`,
          [r.converted, r.conversions, r.value_sum, r.value_squares, r.conversion_squares],
        ]),
      ),
    ).toEqual(expConversions);
    expect(expConversions.size).toBeGreaterThan(20);
    // Spread over many hours, as the test intends.
    expect(new Set(rows.exposures.map((r) => r.hour.getTime())).size).toBeGreaterThan(30);
  });
});
