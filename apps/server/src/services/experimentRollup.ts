import { sql } from 'kysely';
import type { Logger } from 'pino';
import type { Db } from '../db/database.js';
import type { Metrics } from '../metrics.js';

/**
 * How long after its first exposure a context's conversions count towards
 * the variant it saw. Rollups are computed with this window; it is fixed so
 * rows rolled up by different instances or releases always mean the same.
 */
export const ATTRIBUTION_WINDOW_MS = 7 * 86_400_000;

const HOUR_MS = 3_600_000;
const WINDOW = sql.raw(`interval '${ATTRIBUTION_WINDOW_MS} milliseconds'`);

/** Pending conversion contexts resolved to cohort hours per statement. */
const RESOLVE_BATCH = 5000;

/** The UTC hour a time falls in. */
export function cohortHour(at: Date | number): Date {
  const ms = typeof at === 'number' ? at : at.getTime();
  return new Date(Math.floor(ms / HOUR_MS) * HOUR_MS);
}

export interface Slice {
  environmentId: string;
  flag: string;
  hour: Date;
}

type Outcome = 'rolled_up' | 'empty' | 'busy' | 'conflict';

function isSerializationFailure(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === '40001' || code === '40P01';
}

/**
 * Turns contexts with new conversions into the cohort hours they count in:
 * every hour holding a first exposure of that context that a conversion in
 * the reported range could be attributed to. One statement, so the pending
 * rows it deletes and the exposures it joins share a snapshot; an exposure
 * committed after that snapshot marked its own hour when it was written, and
 * the conversion was committed before (its pending row was visible), so the
 * hour's recompute sees both either way.
 */
export async function resolvePendingConversions(db: Db, limit = RESOLVE_BATCH): Promise<number> {
  const r = await sql<{ resolved: number }>`
    WITH taken AS (
      DELETE FROM experiment_rollup_pending
      WHERE id IN (
        SELECT id FROM experiment_rollup_pending ORDER BY id LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING environment_id, context_key, first_occurred_at, last_occurred_at
    ),
    marked AS (
      INSERT INTO experiment_rollup_dirty (environment_id, flag_key, hour)
      SELECT DISTINCT e.environment_id, e.flag_key, date_trunc('hour', e.first_at, 'UTC')
      FROM taken t
      JOIN experiment_exposures e
        ON e.environment_id = t.environment_id
        AND e.context_key = t.context_key
        AND e.first_at <= t.last_occurred_at
        AND e.first_at > t.first_occurred_at - ${WINDOW}
      RETURNING 1
    )
    SELECT count(*)::int AS resolved FROM taken
  `.execute(db);
  return r.rows[0]?.resolved ?? 0;
}

/**
 * Recomputes one marked cohort hour of one flag from the raw tables and
 * replaces its rollup rows. The transaction is REPEATABLE READ, so the marks
 * it deletes are exactly the ones its snapshot sees, and the recompute
 * includes everything those marks stood for; a mark committed later stays
 * for the next pass. A transaction-scoped advisory lock keeps two instances
 * off the same slice, and if a stale snapshot ever races one that just
 * finished, Postgres refuses the second with a serialization failure, which
 * leaves its marks for a later pass. The result depends only on the raw rows,
 * so rolling a slice up again, on any instance, writes the same rows.
 */
export async function rollUpNext(db: Db): Promise<{ outcome: Outcome; slice?: Slice }> {
  try {
    return await db
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute(async (trx) => {
        const next = await trx
          .selectFrom('experiment_rollup_dirty')
          .select(['environment_id', 'flag_key', 'hour'])
          .orderBy('id')
          .limit(1)
          .forUpdate()
          .skipLocked()
          .executeTakeFirst();
        if (next === undefined) return { outcome: 'empty' as const };
        const slice: Slice = {
          environmentId: next.environment_id,
          flag: next.flag_key,
          hour: next.hour,
        };
        const lockKey = `experiment_rollup|${slice.environmentId}|${slice.hour.toISOString()}|${slice.flag}`;
        const locked = await sql<{ ok: boolean }>`
          SELECT pg_try_advisory_xact_lock(hashtextextended(${lockKey}, 0)) AS ok
        `.execute(trx);
        if (locked.rows[0]?.ok !== true) return { outcome: 'busy' as const, slice };

        await trx
          .deleteFrom('experiment_rollup_dirty')
          .where('environment_id', '=', slice.environmentId)
          .where('flag_key', '=', slice.flag)
          .where('hour', '=', slice.hour)
          .execute();
        await trx
          .deleteFrom('experiment_rollup_exposures')
          .where('environment_id', '=', slice.environmentId)
          .where('flag_key', '=', slice.flag)
          .where('hour', '=', slice.hour)
          .execute();
        await trx
          .deleteFrom('experiment_rollup_conversions')
          .where('environment_id', '=', slice.environmentId)
          .where('flag_key', '=', slice.flag)
          .where('hour', '=', slice.hour)
          .execute();

        const end = new Date(slice.hour.getTime() + HOUR_MS);
        await sql`
          INSERT INTO experiment_rollup_exposures
            (environment_id, flag_key, hour, variant, contexts)
          SELECT environment_id, flag_key, ${slice.hour}::timestamptz, variant, count(*)
          FROM experiment_exposures
          WHERE environment_id = ${slice.environmentId}
            AND flag_key = ${slice.flag}
            AND first_at >= ${slice.hour}
            AND first_at < ${end}
          GROUP BY environment_id, flag_key, variant
        `.execute(trx);
        // Per context first (its conversions and summed value inside the
        // window), then per variant, so the squares are of per-context totals.
        await sql`
          INSERT INTO experiment_rollup_conversions
            (environment_id, flag_key, event_key, hour, variant,
             converted, conversions, value_sum, value_squares, conversion_squares)
          SELECT ${slice.environmentId}::uuid, ${slice.flag}::text, event_key,
            ${slice.hour}::timestamptz, variant,
            count(*), sum(n), sum(v), sum(v * v), sum(n * n)
          FROM (
            SELECT e.variant, c.event_key, e.context_key,
              count(*) AS n, coalesce(sum(c.value), 0) AS v
            FROM experiment_exposures e
            JOIN conversion_events c
              ON c.environment_id = e.environment_id
              AND c.context_key = e.context_key
              AND c.occurred_at >= e.first_at
              AND c.occurred_at < e.first_at + ${WINDOW}
            WHERE e.environment_id = ${slice.environmentId}
              AND e.flag_key = ${slice.flag}
              AND e.first_at >= ${slice.hour}
              AND e.first_at < ${end}
            GROUP BY e.variant, c.event_key, e.context_key
          ) per_context
          GROUP BY event_key, variant
        `.execute(trx);
        return { outcome: 'rolled_up' as const, slice };
      });
  } catch (err) {
    if (isSerializationFailure(err)) return { outcome: 'conflict' };
    throw err;
  }
}

/**
 * A housekeeping job that resolves pending conversions and rolls up marked
 * cohort hours, at most `budget` hours per turn. Any number of instances can
 * run it at once. Returns how many hours it rolled up.
 */
export function experimentRollup(o: {
  db: Db;
  metrics: Metrics;
  logger: Logger;
  budget?: number;
}): () => Promise<number> {
  const budget = o.budget ?? 200;
  return async () => {
    for (let i = 0; i < 100; i++) {
      if ((await resolvePendingConversions(o.db)) < RESOLVE_BATCH) break;
    }
    let rolled = 0;
    while (rolled < budget) {
      const { outcome, slice } = await rollUpNext(o.db);
      if (outcome === 'empty') break;
      o.metrics.experimentRollups.inc({ result: outcome });
      if (outcome !== 'rolled_up') {
        // Another instance has this hour, or just finished it; leave the
        // rest of the queue to this turn's other workers and come back later.
        o.logger.debug({ outcome, slice }, 'experiment rollup yielded');
        break;
      }
      rolled++;
    }
    return rolled;
  };
}

/** Marks and pending contexts not yet rolled up; zero once the rollup has caught up. */
export async function rollupBacklog(db: Db): Promise<{ hours: number; contexts: number }> {
  const r = await sql<{ hours: number; contexts: number }>`
    SELECT
      (SELECT count(*) FROM experiment_rollup_dirty)::int AS hours,
      (SELECT count(*) FROM experiment_rollup_pending)::int AS contexts
  `.execute(db);
  return r.rows[0] ?? { hours: 0, contexts: 0 };
}

export interface RolledUpVariant {
  variant: string;
  /** Contexts first exposed to this variant in the range. */
  exposed: number;
  /** Of those, how many converted at least once inside the window. */
  converted: number;
  /** Their conversions inside the window. */
  conversions: number;
  /** Sum of those conversions' values (conversions without one count 0). */
  value: number;
  /** Sum over contexts of the square of each context's summed value. */
  valueSquares: number;
  /** Sum over contexts of the square of each context's conversion count. */
  conversionSquares: number;
}

/**
 * Per-variant results for one flag and event from the hourly rollup, for
 * contexts first exposed in [from, to) (whole hours; a bound inside an hour
 * takes the hour it falls in). Unexposed variants don't appear; variants
 * with exposures but no conversions show zeros.
 */
export async function rolledUpConversions(
  db: Db,
  q: { environmentId: string; flag: string; event: string; from?: Date; to?: Date },
): Promise<RolledUpVariant[]> {
  const from = q.from === undefined ? undefined : cohortHour(q.from);
  const to = q.to === undefined ? undefined : cohortHour(q.to.getTime() + HOUR_MS - 1);
  const exposed = await db
    .selectFrom('experiment_rollup_exposures')
    .select(['variant', sql<number>`sum(contexts)::int`.as('exposed')])
    .where('environment_id', '=', q.environmentId)
    .where('flag_key', '=', q.flag)
    .$if(from !== undefined, (b) => b.where('hour', '>=', from as Date))
    .$if(to !== undefined, (b) => b.where('hour', '<', to as Date))
    .groupBy('variant')
    .orderBy('variant')
    .execute();
  const converted = await db
    .selectFrom('experiment_rollup_conversions')
    .select([
      'variant',
      sql<number>`sum(converted)::int`.as('converted'),
      sql<number>`sum(conversions)::int8`.as('conversions'),
      sql<number>`sum(value_sum)::float8`.as('value'),
      sql<number>`sum(value_squares)::float8`.as('valueSquares'),
      sql<number>`sum(conversion_squares)::int8`.as('conversionSquares'),
    ])
    .where('environment_id', '=', q.environmentId)
    .where('flag_key', '=', q.flag)
    .where('event_key', '=', q.event)
    .$if(from !== undefined, (b) => b.where('hour', '>=', from as Date))
    .$if(to !== undefined, (b) => b.where('hour', '<', to as Date))
    .groupBy('variant')
    .execute();
  const byVariant = new Map(converted.map((r) => [r.variant, r]));
  return exposed.map((e) => {
    const c = byVariant.get(e.variant);
    return {
      variant: e.variant,
      exposed: e.exposed,
      converted: c?.converted ?? 0,
      conversions: c?.conversions ?? 0,
      value: c?.value ?? 0,
      valueSquares: c?.valueSquares ?? 0,
      conversionSquares: c?.conversionSquares ?? 0,
    };
  });
}
