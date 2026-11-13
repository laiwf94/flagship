import { sql } from 'kysely';
import type { Logger } from 'pino';
import type { Db } from '../db/database.js';
import type { Metrics } from '../metrics.js';
import { inReportingWindow } from './exposures.js';

/** A context's first exposure to a flag, reported once per context by the SDK. */
export interface FirstExposureEvent {
  flag: string;
  variant: string;
  /** The context key. */
  key: string;
  /** When the context was first served, epoch milliseconds. */
  at: number;
}

/** A conversion reported by `track()`. */
export interface ConversionEvent {
  /** Chosen by the SDK; the same id twice is the same conversion (a retry). */
  id: string;
  event: string;
  key: string;
  value?: number | undefined;
  at: number;
}

export interface ExposureRecord {
  environmentId: string;
  flag: string;
  key: string;
  variant: string;
  at: number;
}

export interface ConversionRecord {
  environmentId: string;
  id: string;
  event: string;
  key: string;
  value: number | null;
  at: number;
}

export interface ExperimentBatch {
  exposures: ExposureRecord[];
  conversions: ConversionRecord[];
  /** When the batch was taken from the queue; stored as each conversion's received_at. */
  receivedAt: Date;
}

/** An offer checked against the queue bound but not yet added; see ExposureQueue.prepare. */
export interface Prepared {
  readonly fits: boolean;
  readonly dropped: number;
  commit(): void;
  reject(): void;
}

/** Whether `a` is an earlier first exposure than `b`; the variant key breaks a tie. */
function earlier(a: { at: number; variant: string }, b: { at: number; variant: string }): boolean {
  return a.at < b.at || (a.at === b.at && a.variant < b.variant);
}

/**
 * First exposures and conversions waiting to be written. The bound counts
 * pending records, each of which costs memory: one per (environment, flag,
 * context) for exposures, since only the earliest matters, and one per
 * conversion id. As with exposure counts, a batch that doesn't fit is refused
 * whole so the SDK keeps it and retries.
 */
export class ExperimentEventQueue {
  private exposures = new Map<string, ExposureRecord>();
  private conversions = new Map<string, ConversionRecord>();
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;

  constructor(
    private readonly o: {
      write: (batch: ExperimentBatch) => Promise<void>;
      limit: number;
      flushMs: number;
      metrics: Metrics;
      logger: Logger;
      now: () => Date;
    },
  ) {
    o.metrics.experimentQueue.collect(() => {
      o.metrics.experimentQueue.set(this.size);
    });
  }

  get size(): number {
    return this.exposures.size + this.conversions.size;
  }

  prepare(
    environmentId: string,
    exposures: readonly FirstExposureEvent[],
    conversions: readonly ConversionEvent[],
  ): Prepared {
    const now = this.o.now().getTime();
    const m = this.o.metrics.experimentEvents;
    const e: ExposureRecord[] = [];
    const c: ConversionRecord[] = [];
    let droppedExposures = 0;
    let droppedConversions = 0;
    for (const x of exposures) {
      if (inReportingWindow(x.at, now)) e.push({ environmentId, ...x });
      else droppedExposures++;
    }
    for (const x of conversions) {
      if (inReportingWindow(x.at, now)) {
        c.push({
          environmentId,
          id: x.id,
          event: x.event,
          key: x.key,
          value: x.value ?? null,
          at: x.at,
        });
      } else droppedConversions++;
    }
    const fresh = new Set<string>();
    for (const r of e) {
      const k = exposureKey(r);
      if (!this.exposures.has(k)) fresh.add(k);
    }
    for (const r of c) {
      const k = conversionKey(r);
      if (!this.conversions.has(k)) fresh.add(k);
    }
    const fits = this.size + fresh.size <= this.o.limit;
    return {
      fits,
      dropped: droppedExposures + droppedConversions,
      commit: () => {
        for (const r of e) this.addExposure(r);
        for (const r of c) this.addConversion(r);
        if (e.length > 0) m.inc({ kind: 'exposure', result: 'accepted' }, e.length);
        if (c.length > 0) m.inc({ kind: 'conversion', result: 'accepted' }, c.length);
        if (droppedExposures > 0) m.inc({ kind: 'exposure', result: 'dropped' }, droppedExposures);
        if (droppedConversions > 0) {
          m.inc({ kind: 'conversion', result: 'dropped' }, droppedConversions);
        }
      },
      reject: () => {
        if (exposures.length > 0) {
          m.inc({ kind: 'exposure', result: 'rejected' }, exposures.length);
        }
        if (conversions.length > 0) {
          m.inc({ kind: 'conversion', result: 'rejected' }, conversions.length);
        }
      },
    };
  }

  private addExposure(r: ExposureRecord): void {
    const k = exposureKey(r);
    const seen = this.exposures.get(k);
    if (seen === undefined || earlier(r, seen)) this.exposures.set(k, r);
  }

  private addConversion(r: ConversionRecord): void {
    const k = conversionKey(r);
    if (!this.conversions.has(k)) this.conversions.set(k, r);
  }

  start(): void {
    this.timer = setInterval(() => {
      void this.flush();
    }, this.o.flushMs);
    this.timer.unref();
  }

  /** Writes everything pending. On failure the records go back for the next try. */
  flush(): Promise<void> {
    this.flushing ??= this.doFlush().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async doFlush(): Promise<void> {
    if (this.size === 0) return;
    const exposures = [...this.exposures.values()];
    const conversions = [...this.conversions.values()];
    this.exposures = new Map();
    this.conversions = new Map();
    try {
      await this.o.write({ exposures, conversions, receivedAt: this.o.now() });
    } catch (err) {
      this.o.logger.warn(
        { err, exposures: exposures.length, conversions: conversions.length },
        'experiment event flush failed; will retry',
      );
      // Writes are idempotent, so putting back a batch that was half written is safe.
      for (const r of exposures) this.addExposure(r);
      for (const r of conversions) this.addConversion(r);
    }
  }

  async stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }
}

function exposureKey(r: ExposureRecord): string {
  return `${r.environmentId}\u0000${r.flag}\u0000${r.key}`;
}

function conversionKey(r: ConversionRecord): string {
  return `${r.environmentId}\u0000${r.id}`;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Upserts first exposures, keeping the earliest per context and flag
 * whichever instance or batch reports it, and inserts conversions once per id.
 * Rows go in key order so two instances flushing at once lock rows in the same
 * order.
 */
export function experimentWriter(db: Db) {
  return async (batch: ExperimentBatch): Promise<void> => {
    const exposures = [...batch.exposures].sort((a, b) => compare(exposureKey(a), exposureKey(b)));
    for (let i = 0; i < exposures.length; i += 1000) {
      await db
        .insertInto('experiment_exposures')
        .values(
          exposures.slice(i, i + 1000).map((r) => ({
            environment_id: r.environmentId,
            flag_key: r.flag,
            context_key: r.key,
            variant: r.variant,
            first_at: new Date(r.at),
          })),
        )
        .onConflict((oc) =>
          oc
            .columns(['environment_id', 'flag_key', 'context_key'])
            .doUpdateSet({
              variant: sql`excluded.variant`,
              first_at: sql`excluded.first_at`,
            })
            .where(
              sql<boolean>`(excluded.first_at, excluded.variant) < (experiment_exposures.first_at, experiment_exposures.variant)`,
            ),
        )
        .execute();
    }
    const conversions = [...batch.conversions].sort((a, b) =>
      compare(conversionKey(a), conversionKey(b)),
    );
    for (let i = 0; i < conversions.length; i += 1000) {
      await db
        .insertInto('conversion_events')
        .values(
          conversions.slice(i, i + 1000).map((r) => ({
            environment_id: r.environmentId,
            id: r.id,
            event_key: r.event,
            context_key: r.key,
            value: r.value,
            occurred_at: new Date(r.at),
            received_at: batch.receivedAt,
          })),
        )
        .onConflict((oc) => oc.columns(['environment_id', 'id']).doNothing())
        .execute();
    }
  };
}

export interface AttributedVariant {
  variant: string;
  /** Contexts whose first exposure to the flag was this variant. */
  exposed: number;
  /** Of those, how many converted at least once inside the window. */
  converted: number;
  /** Their conversions inside the window. */
  conversions: number;
  /** Sum of those conversions' values (conversions without one count 0). */
  value: number;
}

/**
 * Conversions attributed to the first exposure per context: a conversion
 * counts for the variant the context was first served, if it happened at or
 * after that exposure and within `windowMs` of it. Conversions before a
 * context's first exposure, or from contexts never exposed, count for no one.
 */
export async function attributedConversions(
  db: Db,
  q: {
    environmentId: string;
    flag: string;
    event: string;
    windowMs: number;
    /** Only contexts first exposed in [from, to). */
    from?: Date;
    to?: Date;
  },
): Promise<AttributedVariant[]> {
  const window = `${Math.max(0, Math.floor(q.windowMs))} milliseconds`;
  const rows = await db
    .selectFrom('experiment_exposures as e')
    .leftJoin('conversion_events as c', (join) =>
      join
        .onRef('c.environment_id', '=', 'e.environment_id')
        .onRef('c.context_key', '=', 'e.context_key')
        .on('c.event_key', '=', q.event)
        .onRef('c.occurred_at', '>=', 'e.first_at')
        .on(sql<boolean>`c.occurred_at < e.first_at + ${window}::interval`),
    )
    .select([
      'e.variant',
      sql<number>`count(DISTINCT e.context_key)::int`.as('exposed'),
      sql<number>`count(DISTINCT c.context_key)::int`.as('converted'),
      sql<number>`count(c.id)::int`.as('conversions'),
      sql<number>`coalesce(sum(c.value), 0)::float8`.as('value'),
    ])
    .where('e.environment_id', '=', q.environmentId)
    .where('e.flag_key', '=', q.flag)
    .$if(q.from !== undefined, (b) => b.where('e.first_at', '>=', q.from as Date))
    .$if(q.to !== undefined, (b) => b.where('e.first_at', '<', q.to as Date))
    .groupBy('e.variant')
    .orderBy('e.variant')
    .execute();
  return rows;
}
