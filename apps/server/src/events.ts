import { sql } from 'kysely';
import type { Logger } from 'pino';
import type { Db } from './db/database.js';
import type { Metrics } from './metrics.js';

/**
 * The internal event bus.
 *
 * Every change writes an audit entry inside the transaction that makes it, so
 * the audit log is also the event log: an event is an audit entry, published
 * exactly when the change commits and never when it rolls back. Each entry
 * records the id of the transaction that wrote it (migration 014), and a
 * statement trigger sends a NOTIFY on `flagship_events`, which Postgres
 * delivers at commit.
 *
 * Readers take entries in (transaction id, entry id) order, and only from
 * transactions older than the oldest one still running. Ordering by entry id
 * alone would skip an entry whose transaction took its id early and committed
 * late; below that horizon every transaction has finished, so nothing can
 * still appear behind a reader's position. A long transaction holds events
 * back until it ends rather than letting anything be skipped.
 *
 * Two kinds of handler:
 * - live handlers (`on`) see, on every instance and in order, every event
 *   from the head at the time they registered: everything committed after
 *   that, and anything committed just before that wasn't readable yet; a
 *   handler that throws is logged and skipped;
 * - durable consumers (`consume`) keep their position in `event_consumers`
 *   and handle each batch inside the transaction that advances it, holding
 *   the row with FOR UPDATE SKIP LOCKED: whatever the handler writes commits
 *   together with the new position, so each event is handled exactly once
 *   across all instances, and a handler that throws rolls back and gets the
 *   same batch again on the next round.
 *
 * NOTIFY wakes the bus; a slow poll covers notifications lost while the
 * listening connection was down. When committed events are waiting behind an
 * older running transaction, the bus reads again after a short backoff
 * instead of waiting for the next notification or poll.
 */

export const EVENTS_CHANNEL = 'flagship_events';

/** One committed change, as its audit entry recorded it. */
export interface ChangeEvent {
  /** The audit entry id. */
  id: number;
  /** Id of the transaction that wrote it (xid8, as text). */
  tx: string;
  at: Date;
  projectId: string | null;
  environmentId: string | null;
  /** The audit action, such as `flag.config.update` or `flag.kill_switch`. */
  action: string;
  targetType: string;
  targetKey: string;
  actor: { id: string | null; name: string };
  reason: string | null;
  link: string | null;
  before: unknown;
  after: unknown;
}

/** A position in the event log: everything up to and including this (tx, id) has been read. */
export interface EventCursor {
  tx: string;
  id: number;
}

export type LiveHandler = (events: readonly ChangeEvent[]) => void | Promise<void>;
/** Handles a batch inside the transaction that advances the consumer; write through `trx`. */
export type DurableHandler = (trx: Db, events: readonly ChangeEvent[]) => Promise<void>;

const CONSUMER_NAME = /^[a-z][a-z0-9_.-]{0,62}$/;

/**
 * The current head: a cursor before every event not yet visible to readers.
 * Events from transactions still running when this is read come after it.
 */
export async function eventHead(db: Db): Promise<EventCursor> {
  const row = await sql<{ tx: string }>`
    SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS tx`.execute(db);
  const tx = row.rows[0]?.tx;
  if (tx === undefined) throw new Error('no snapshot');
  return { tx, id: 0 };
}

export interface EventBatch {
  events: ChangeEvent[];
  /**
   * Whether committed events after these are being held back by an older
   * transaction that is still running; read again soon.
   */
  held: boolean;
}

/**
 * Up to `limit` events after `after`, in order, from transactions below the
 * horizon. Uses the partial (tx, id) index on audit_log.
 */
export async function readEvents(db: Db, after: EventCursor, limit: number): Promise<EventBatch> {
  const rows = await db
    .selectFrom('audit_log')
    .select([
      'id',
      sql<string>`tx::text`.as('tx'),
      'created_at',
      'project_id',
      'environment_id',
      'action',
      'target_type',
      'target_key',
      'actor_id',
      'actor_name',
      'reason',
      'link',
      'before',
      'after',
      // Committed rows at or above the horizon sort after every row below it.
      sql<boolean>`tx < pg_snapshot_xmin(pg_current_snapshot())`.as('ready'),
    ])
    .where('tx', 'is not', null)
    .where(sql<boolean>`(tx, id) > (${after.tx}::xid8, ${after.id}::bigint)`)
    .orderBy('tx')
    .orderBy('id')
    .limit(limit)
    .execute();
  const ready = rows.filter((r) => r.ready);
  const events = ready.map((r) => ({
    id: r.id,
    tx: r.tx,
    at: r.created_at,
    projectId: r.project_id,
    environmentId: r.environment_id,
    action: r.action,
    targetType: r.target_type,
    targetKey: r.target_key,
    actor: { id: r.actor_id, name: r.actor_name },
    reason: r.reason,
    link: r.link,
    before: r.before ?? null,
    after: r.after ?? null,
  }));
  return { events, held: ready.length < rows.length };
}

export interface EventBusOptions {
  db: Db;
  logger: Logger;
  metrics: Metrics;
  /** Fallback poll, for notifications missed while the listener was reconnecting. */
  pollMs?: number;
  /** Events read per batch. */
  batch?: number;
}

interface Durable {
  name: string;
  handler: DurableHandler;
  registered: boolean;
}

export class EventBus {
  private readonly live = new Set<LiveHandler>();
  private liveCursor: EventCursor | null = null;
  /** Bumped when the last live handler leaves, so a read in flight can't move a fresh cursor back. */
  private liveGeneration = 0;
  private readonly durable = new Map<string, Durable>();
  private timer: NodeJS.Timeout | null = null;
  /** Re-reads while events are held back, backing off from 25 ms up to the poll interval. */
  private retry: NodeJS.Timeout | null = null;
  private retryMs = 0;
  private running: Promise<void> | null = null;
  private again = false;
  private closed = false;
  private readonly batch: number;

  constructor(private readonly o: EventBusOptions) {
    this.batch = o.batch ?? 100;
  }

  private get pollMs(): number {
    return this.o.pollMs ?? 5000;
  }

  start(): void {
    this.timer = setInterval(() => {
      this.wake();
    }, this.pollMs);
    this.timer.unref();
  }

  /**
   * Registers a live handler for events from the current head on. Resolves once
   * the handler's starting position is fixed. Returns a function that removes it.
   */
  async on(handler: LiveHandler): Promise<() => void> {
    if (this.liveCursor === null) {
      const head = await eventHead(this.o.db);
      // Another registration may have fixed the position while this one read the head.
      this.liveCursor ??= head;
    }
    this.live.add(handler);
    return () => {
      if (this.live.delete(handler) && this.live.size === 0) {
        this.liveCursor = null;
        this.liveGeneration++;
      }
    };
  }

  /**
   * Registers a durable consumer. A consumer seen for the first time starts at
   * the current head; one that existed before carries on from its stored position.
   */
  consume(name: string, handler: DurableHandler): void {
    if (!CONSUMER_NAME.test(name)) throw new Error(`invalid consumer name "${name}"`);
    if (this.durable.has(name)) throw new Error(`consumer "${name}" is already registered`);
    this.durable.set(name, { name, handler, registered: false });
    this.wake();
  }

  /** Called on a NOTIFY: reads and dispatches new events, coalescing overlapping calls. */
  wake(): void {
    if (this.closed) return;
    if (this.running !== null) {
      this.again = true;
      return;
    }
    this.running = this.drainLoop().finally(() => {
      this.running = null;
    });
  }

  /** Resolves once everything visible when called has been dispatched. */
  async drain(): Promise<void> {
    this.wake();
    while (this.running !== null) await this.running;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== null) clearInterval(this.timer);
    if (this.retry !== null) clearTimeout(this.retry);
    this.timer = null;
    this.retry = null;
    await this.running;
  }

  private async drainLoop(): Promise<void> {
    let held: boolean;
    do held = await this.drainOnce();
    while (this.takeAgain() && !this.closed);
    if (!held) {
      this.retryMs = 0;
      return;
    }
    if (this.closed || this.retry !== null) return;
    this.retryMs = Math.min(Math.max(this.retryMs * 2, 25), this.pollMs);
    this.retry = setTimeout(() => {
      this.retry = null;
      this.wake();
    }, this.retryMs);
    this.retry.unref();
  }

  /** Whether a wake arrived during the last round, clearing it. */
  private takeAgain(): boolean {
    const again = this.again;
    this.again = false;
    return again;
  }

  /** One round over live handlers and durable consumers; returns whether events were held back. */
  private async drainOnce(): Promise<boolean> {
    let held = false;
    try {
      held = await this.dispatchLive();
    } catch (err) {
      this.o.logger.warn({ err }, 'event bus read failed');
    }
    for (const consumer of this.durable.values()) {
      try {
        for (;;) {
          const batch = await this.consumeBatch(consumer);
          held ||= batch.held;
          if (batch.handled < this.batch || this.closed) break;
        }
      } catch (err) {
        this.o.metrics.busEvents.inc({ consumer: consumer.name, result: 'error' });
        this.o.logger.error({ err, consumer: consumer.name }, 'event consumer failed; will retry');
      }
    }
    return held;
  }

  /** Returns whether events were held back. */
  private async dispatchLive(): Promise<boolean> {
    while (this.live.size > 0 && this.liveCursor !== null) {
      const generation = this.liveGeneration;
      const { events, held } = await readEvents(this.o.db, this.liveCursor, this.batch);
      if (events.length === 0 || generation !== this.liveGeneration) return held;
      for (const handler of this.live) {
        try {
          await handler(events);
          this.o.metrics.busEvents.inc({ consumer: 'live', result: 'ok' }, events.length);
        } catch (err) {
          this.o.metrics.busEvents.inc({ consumer: 'live', result: 'error' }, events.length);
          this.o.logger.error({ err }, 'live event handler failed');
        }
      }
      const last = events[events.length - 1];
      if (last !== undefined && generation === this.liveGeneration) {
        this.liveCursor = { tx: last.tx, id: last.id };
      }
      if (events.length < this.batch) return held;
    }
    return false;
  }

  /** Handles one batch for a durable consumer. */
  private async consumeBatch(c: Durable): Promise<{ handled: number; held: boolean }> {
    if (!c.registered) {
      await sql`
        INSERT INTO event_consumers (name, tx, audit_id)
        VALUES (${c.name}, pg_snapshot_xmin(pg_current_snapshot()), 0)
        ON CONFLICT (name) DO NOTHING`.execute(this.o.db);
      c.registered = true;
    }
    return this.o.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('event_consumers')
        .select([sql<string>`tx::text`.as('tx'), 'audit_id'])
        .where('name', '=', c.name)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      // Held by another instance, which is handling the same events right now.
      if (row === undefined) return { handled: 0, held: false };
      const { events, held } = await readEvents(trx, { tx: row.tx, id: row.audit_id }, this.batch);
      const last = events[events.length - 1];
      if (last === undefined) return { handled: 0, held };
      await c.handler(trx, events);
      await trx
        .updateTable('event_consumers')
        .set({ tx: sql<string>`${last.tx}::xid8`, audit_id: last.id, updated_at: new Date() })
        .where('name', '=', c.name)
        .execute();
      this.o.metrics.busEvents.inc({ consumer: c.name, result: 'ok' }, events.length);
      return { handled: events.length, held };
    });
  }
}
