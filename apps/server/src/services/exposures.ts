import { sql } from 'kysely';
import type { Logger } from 'pino';
import type { Db } from '../db/database.js';
import type { Metrics } from '../metrics.js';
import type { Prepared } from './experimentEvents.js';

export interface ExposureEvent {
  flag: string;
  variant: string;
  count: number;
  /** Start of the SDK's aggregation window, epoch milliseconds. */
  at?: number | undefined;
}

export interface ExposureRow {
  environmentId: string;
  flag: string;
  variant: string;
  hour: Date;
  count: number;
}

const HOUR = 3_600_000;
const MAX_AGE = 7 * 24 * HOUR;
const MAX_SKEW = 5 * 60_000;

function hourOf(ms: number): number {
  return Math.floor(ms / HOUR) * HOUR;
}

/** SDK timestamps older than a week, or more than five minutes ahead, are dropped. */
export function inReportingWindow(at: number, now: number): boolean {
  return at >= now - MAX_AGE && at <= now + MAX_SKEW;
}

/**
 * Accepted exposure counts waiting to be written. Bounded by the number of
 * distinct (environment, flag, variant, hour) rows, which is what costs
 * memory; a batch that would go over the bound is refused as a whole with
 * 429 so the SDK keeps it and retries, instead of half of it being lost.
 */
export class ExposureQueue {
  private pending = new Map<string, ExposureRow>();
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private followUp: Promise<void> | null = null;

  constructor(
    private readonly o: {
      write: (rows: ExposureRow[]) => Promise<void>;
      limit: number;
      flushMs: number;
      metrics: Metrics;
      logger: Logger;
      now: () => Date;
    },
  ) {
    o.metrics.exposureQueue.collect(() => {
      o.metrics.exposureQueue.set(this.pending.size);
    });
  }

  get size(): number {
    return this.pending.size;
  }

  /** Returns the number of events dropped for bad timestamps, or undefined if the queue is full. */
  offer(environmentId: string, events: readonly ExposureEvent[]): { dropped: number } | undefined {
    const prepared = this.prepare(environmentId, events);
    if (!prepared.fits) {
      prepared.reject();
      return undefined;
    }
    prepared.commit();
    return { dropped: prepared.dropped };
  }

  /**
   * Checks a batch against the bound without adding it, so the events route
   * can refuse a request whole when any of its queues is full. Nothing may
   * touch the queue between this and `commit`.
   */
  prepare(environmentId: string, events: readonly ExposureEvent[]): Prepared {
    const now = this.o.now().getTime();
    const rows: ExposureRow[] = [];
    let dropped = 0;
    for (const e of events) {
      const at = e.at ?? now;
      if (!inReportingWindow(at, now)) {
        dropped += e.count;
        continue;
      }
      rows.push({
        environmentId,
        flag: e.flag,
        variant: e.variant,
        hour: new Date(hourOf(at)),
        count: e.count,
      });
    }
    const fresh = new Set<string>();
    for (const r of rows) {
      const key = this.key(r);
      if (!this.pending.has(key)) fresh.add(key);
    }
    const m = this.o.metrics.exposures;
    return {
      fits: this.pending.size + fresh.size <= this.o.limit,
      dropped,
      commit: () => {
        for (const r of rows) this.add(r);
        m.inc(
          { result: 'accepted' },
          rows.reduce((n, r) => n + r.count, 0),
        );
        if (dropped > 0) m.inc({ result: 'dropped' }, dropped);
      },
      reject: () => {
        m.inc(
          { result: 'rejected' },
          events.reduce((n, e) => n + e.count, 0),
        );
      },
    };
  }

  private key(r: ExposureRow): string {
    return `${r.environmentId}\u0000${r.flag}\u0000${r.variant}\u0000${r.hour.getTime()}`;
  }

  private add(r: ExposureRow): void {
    const key = this.key(r);
    const existing = this.pending.get(key);
    if (existing === undefined) this.pending.set(key, { ...r });
    else existing.count += r.count;
  }

  start(): void {
    this.timer = setInterval(() => {
      void this.flush();
    }, this.o.flushMs);
    this.timer.unref();
  }

  /** Writes everything pending. On failure the rows go back into the queue for the next try. */
  flush(): Promise<void> {
    if (this.flushing === null) {
      this.flushing = this.doFlush().finally(() => {
        this.flushing = null;
      });
      return this.flushing;
    }
    // The running flush took only what was pending when it started; one more
    // after it writes what came since. Callers arriving meanwhile share it.
    this.followUp ??= this.flushing.then(() => {
      this.followUp = null;
      return this.flush();
    });
    return this.followUp;
  }

  private async doFlush(): Promise<void> {
    if (this.pending.size === 0) return;
    const batch = [...this.pending.values()];
    this.pending = new Map();
    try {
      await this.o.write(batch);
    } catch (err) {
      this.o.logger.warn({ err, rows: batch.length }, 'exposure flush failed; will retry');
      for (const r of batch) this.add(r);
    }
  }

  async stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }
}

/**
 * The latest hour each (environment, flag) was seen in, in key order so two
 * instances flushing at once take row locks in the same order.
 */
export function lastEvaluations(rows: readonly ExposureRow[]) {
  const latest = new Map<
    string,
    { environment_id: string; flag_key: string; last_evaluated_at: Date }
  >();
  for (const r of rows) {
    const key = `${r.environmentId}\u0000${r.flag}`;
    const seen = latest.get(key);
    if (seen === undefined) {
      latest.set(key, {
        environment_id: r.environmentId,
        flag_key: r.flag,
        last_evaluated_at: r.hour,
      });
    } else if (r.hour > seen.last_evaluated_at) {
      seen.last_evaluated_at = r.hour;
    }
  }
  return [...latest.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v);
}

/**
 * One multi-row upsert per 1,000 rows, then the last-evaluated time per flag,
 * which only moves forward (an SDK may report an older window late).
 */
export function exposureWriter(db: Db) {
  return async (rows: ExposureRow[]): Promise<void> => {
    const seen = lastEvaluations(rows);
    for (let i = 0; i < seen.length; i += 1000) {
      await db
        .insertInto('flag_evaluations')
        .values(seen.slice(i, i + 1000))
        .onConflict((oc) =>
          oc.columns(['environment_id', 'flag_key']).doUpdateSet({
            last_evaluated_at: sql`greatest(flag_evaluations.last_evaluated_at, excluded.last_evaluated_at)`,
          }),
        )
        .execute();
    }
    for (let i = 0; i < rows.length; i += 1000) {
      const chunk = rows.slice(i, i + 1000);
      await db
        .insertInto('exposure_counts')
        .values(
          chunk.map((r) => ({
            environment_id: r.environmentId,
            flag_key: r.flag,
            variant: r.variant,
            hour: r.hour,
            count: r.count,
          })),
        )
        .onConflict((oc) =>
          oc
            .columns(['environment_id', 'flag_key', 'hour', 'variant'])
            .doUpdateSet({ count: sql`exposure_counts.count + excluded.count` }),
        )
        .execute();
    }
  };
}

export interface ExposureSummary {
  from: string;
  to: string;
  totals: { variant: string; count: number }[];
  series: { hour: string; counts: Record<string, number> }[];
}

export async function exposureSummary(
  db: Db,
  environmentId: string,
  flag: string,
  hours: number,
  now: Date,
): Promise<ExposureSummary> {
  const to = hourOf(now.getTime()) + HOUR;
  const from = to - hours * HOUR;
  const rows = await db
    .selectFrom('exposure_counts')
    .select(['hour', 'variant', 'count'])
    .where('environment_id', '=', environmentId)
    .where('flag_key', '=', flag)
    .where('hour', '>=', new Date(from))
    .where('hour', '<', new Date(to))
    .orderBy('hour')
    .execute();
  const totals = new Map<string, number>();
  const byHour = new Map<number, Record<string, number>>();
  for (const r of rows) {
    totals.set(r.variant, (totals.get(r.variant) ?? 0) + r.count);
    const h = r.hour.getTime();
    const counts = byHour.get(h) ?? {};
    counts[r.variant] = (counts[r.variant] ?? 0) + r.count;
    byHour.set(h, counts);
  }
  const series: ExposureSummary['series'] = [];
  for (let h = from; h < to; h += HOUR) {
    series.push({ hour: new Date(h).toISOString(), counts: byHour.get(h) ?? {} });
  }
  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    totals: [...totals.entries()]
      .map(([variant, count]) => ({ variant, count }))
      .sort((a, b) => b.count - a.count),
    series,
  };
}
