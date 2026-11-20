import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApp, type TestApp } from '../test/app.js';
import { PASSWORD, signIn, type Client } from '../test/session.js';
import { createMetrics } from './metrics.js';
import { recordAudit } from './services/audit.js';
import {
  EVENTS_CHANNEL,
  EventBus,
  eventHead,
  readEvents,
  type ChangeEvent,
  type DurableHandler,
} from './events.js';

let t: TestApp;
let admin: Client;

const P = '/api/projects/default';

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const metrics = createMetrics();

/** A bus of its own that never polls, so only explicit drains move it. */
function bus(batch = 100): EventBus {
  return new EventBus({ db: t.db, logger: t.logger, metrics, batch });
}

/**
 * Drains until `check` holds. Other test files share the Postgres server, and
 * their running transactions hold back the horizon below which events are read.
 */
async function drainUntil(buses: EventBus[], check: () => boolean, ms = 10_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    await Promise.all(buses.map((b) => b.drain()));
    if (check()) return;
    if (Date.now() - start > ms) throw new Error('events not delivered in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Writes an audit entry (an event) outside any project, the way services do inside their transaction. */
async function entry(key: string): Promise<void> {
  await recordAudit(t.db, {
    projectId: null,
    actor: { id: null, name: 'test' },
    action: 'test.event',
    targetType: 'test',
    targetKey: key,
  });
}

async function client(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: t.url });
  await c.connect();
  return c;
}

beforeAll(async () => {
  t = await testApp({ bootstrapAdmin: { email: 'root@example.com', password: PASSWORD } });
  admin = await signIn(t.app.server, 'root@example.com');
  await sql`CREATE TABLE handled (consumer text, audit_id bigint, PRIMARY KEY (consumer, audit_id))`.execute(
    t.db,
  );
});
afterAll(() => t.close());

describe('event bus', () => {
  it('delivers a committed change to live handlers through NOTIFY, with the audit details', async () => {
    const seen: ChangeEvent[] = [];
    const off = await t.app.events.on((events) => {
      seen.push(...events);
    });
    const started = Date.now();
    const res = await admin.request('POST', `${P}/flags`, {
      key: 'checkout',
      name: 'Checkout',
      type: 'boolean',
    });
    expect(res.statusCode).toBe(201);
    // The app's fallback poll is every 5 s; the notification arrives well before.
    await until(() => seen.length > 0, 2000);
    expect(Date.now() - started).toBeLessThan(2000);
    const [created] = seen;
    expect(created).toMatchObject({
      action: 'flag.create',
      targetType: 'flag',
      targetKey: 'checkout',
      actor: { name: 'Admin' },
      before: null,
    });
    expect(created?.projectId).toMatch(/^[0-9a-f-]{36}$/);
    expect(created?.after).toMatchObject({ name: 'Checkout', type: 'boolean' });
    expect(created?.tx).toMatch(/^\d+$/);

    const kill = await admin.request(
      'POST',
      `${P}/flags/checkout/environments/production/kill-switch`,
      { enabled: true },
    );
    expect(kill.statusCode).toBe(200);
    await until(() => seen.some((e) => e.action === 'flag.kill_switch'), 2000);
    const toggled = seen.find((e) => e.action === 'flag.kill_switch');
    expect(toggled?.environmentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(toggled?.before).toMatchObject({ enabled: false });
    expect(toggled?.after).toMatchObject({ enabled: true });
    off();
  });

  it('notifies on commit only, and publishes nothing from a rolled-back change', async () => {
    const listener = await client();
    const heard: string[] = [];
    listener.on('notification', (m) => heard.push(m.channel));
    await listener.query(`LISTEN ${EVENTS_CHANNEL}`);
    const b = bus();
    const seen: ChangeEvent[] = [];
    await b.on((events) => {
      seen.push(...events);
    });
    try {
      await expect(
        t.db.transaction().execute(async (trx) => {
          await recordAudit(trx, {
            projectId: null,
            actor: { id: null, name: 'test' },
            action: 'test.event',
            targetType: 'test',
            targetKey: 'rolled-back',
          });
          throw new Error('abort');
        }),
      ).rejects.toThrow('abort');
      await b.drain();
      await new Promise((r) => setTimeout(r, 100));
      expect(heard).toEqual([]);
      expect(seen).toEqual([]);

      await entry('kept');
      await until(() => heard.length === 1, 2000);
      // The rolled-back entry's transaction came first; it would have been delivered before this.
      await drainUntil([b], () => seen.length > 0);
      expect(seen.map((e) => e.targetKey)).toEqual(['kept']);
    } finally {
      await b.close();
      await listener.end();
    }
  });

  it('starts a live handler after what was already committed, even behind an older open transaction', async () => {
    const blocker = await client();
    const b = bus();
    const seen: string[] = [];
    try {
      // An open transaction with an id holds the horizon back below the next entry.
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_current_xact_id()');
      await entry('before-on');
      const off = await b.on((events) => {
        seen.push(...events.map((e) => e.targetKey));
      });
      await blocker.query('ROLLBACK');
      await entry('after-on');
      await drainUntil([b], () => seen.includes('after-on'));
      expect(seen).toEqual(['after-on']);
      off();

      // A second registration after the last handler left starts afresh.
      const again: string[] = [];
      await b.on((events) => {
        again.push(...events.map((e) => e.targetKey));
      });
      await entry('third');
      await drainUntil([b], () => again.includes('third'));
      expect(again).toEqual(['third']);
    } finally {
      await b.close();
      await blocker.end();
    }
  });

  it('never skips an entry whose transaction started first and committed last', async () => {
    const b = bus();
    const seen: string[] = [];
    await b.on((events) => {
      seen.push(...events.map((e) => e.targetKey));
    });
    const slow = await client();
    try {
      await slow.query('BEGIN');
      await slow.query(
        `INSERT INTO audit_log (actor_name, action, target_type, target_key)
         VALUES ('test', 'test.event', 'test', 'slow')`,
      );
      await entry('fast');
      // 'fast' has the larger id and is committed, but a transaction older than
      // it is still running, so it is held back rather than read past 'slow'.
      await b.drain();
      expect(seen).toEqual([]);
      // The head stays at or below the open transaction, whatever else commits.
      const head = await eventHead(t.db);
      const open = await slow.query<{ tx: string }>('SELECT pg_current_xact_id()::text AS tx');
      expect(BigInt(head.tx)).toBeLessThanOrEqual(BigInt(open.rows[0]?.tx ?? '0'));
      await slow.query('COMMIT');
      // No notification or drain here: the bus saw events held back and reads again by itself.
      await until(() => seen.length >= 2, 3000);
      expect(seen).toEqual(['slow', 'fast']);
    } finally {
      await slow.end();
      await b.close();
    }
  });

  it('reads entries in commit-safe order and ignores entries from before the bus', async () => {
    const head = await eventHead(t.db);
    await entry('a');
    await entry('b');
    // An entry written before migration 014 has no transaction id.
    await sql`UPDATE audit_log SET tx = NULL WHERE target_key = 'b'`.execute(t.db);
    let batch = await readEvents(t.db, head, 10);
    const start = Date.now();
    while (batch.events.length === 0 && Date.now() - start < 10_000) {
      await new Promise((r) => setTimeout(r, 20));
      batch = await readEvents(t.db, head, 10);
    }
    expect(batch.events.map((e) => e.targetKey)).toEqual(['a']);
    expect(await readEvents(t.db, head, 0)).toEqual({ events: [], held: false });
  });

  it('hands every event to a durable consumer exactly once across racing instances', async () => {
    const record =
      (name: string): DurableHandler =>
      async (trx, events) => {
        // A duplicate would break the primary key and roll the batch back.
        for (const e of events) {
          await sql`INSERT INTO handled VALUES (${name}, ${e.id})`.execute(trx);
        }
      };
    const instances = [bus(7), bus(7), bus(7)];
    for (const b of instances) b.consume('race', record('race'));
    await Promise.all(instances.map((b) => b.drain()));
    const keys = Array.from({ length: 60 }, (_, i) => `race-${i}`);
    await Promise.all(
      keys.map(async (key, i) => {
        await entry(key);
        if (i % 10 === 0) await Promise.all(instances.map((b) => b.drain()));
      }),
    );
    const handled = async () =>
      (
        await sql<{ target_key: string }>`
          SELECT target_key FROM handled JOIN audit_log ON audit_log.id = handled.audit_id
          WHERE consumer = 'race' AND target_key LIKE 'race-%' ORDER BY target_key`.execute(t.db)
      ).rows.map((r) => r.target_key);
    let rows = await handled();
    const start = Date.now();
    while (rows.length < keys.length && Date.now() - start < 10_000) {
      await Promise.all(instances.map((b) => b.drain()));
      rows = await handled();
    }
    expect(rows).toEqual([...keys].sort());
    for (const b of instances) await b.close();
  });

  it('retries a failed batch, keeps its position across restarts and starts new consumers at the head', async () => {
    const head = await eventHead(t.db);
    await entry('before-consumer');
    // Wait until it is below the horizon, so a consumer registered now starts after it.
    const readable = async () =>
      (await readEvents(t.db, head, 100)).events.some((e) => e.targetKey === 'before-consumer');
    const start = Date.now();
    while (!(await readable()) && Date.now() - start < 10_000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    let failures = 1;
    const batches: string[][] = [];
    const handler: DurableHandler = async (trx, events) => {
      batches.push(events.map((e) => e.targetKey));
      await sql`INSERT INTO handled SELECT 'durable', unnest(${events.map((e) => e.id)}::bigint[])`.execute(
        trx,
      );
      if (failures-- > 0) throw new Error('receiver down');
    };
    const first = bus();
    first.consume('durable', handler);
    await first.drain();
    await t.db.transaction().execute(async (trx) => {
      for (const key of ['one', 'two']) {
        await recordAudit(trx, {
          projectId: null,
          actor: { id: null, name: 'test' },
          action: 'test.event',
          targetType: 'test',
          targetKey: key,
        });
      }
    });
    // The first attempt throws: its writes roll back, and the next round gets the same batch.
    // drain() coalesces wakes, so that retry may already run inside the same drain() call.
    await drainUntil([first], () => batches.length >= 2);
    expect(metrics.registry.render()).toContain(
      'flagship_bus_events_total{consumer="durable",result="error"} 1',
    );
    expect(batches).toEqual([
      ['one', 'two'],
      ['one', 'two'],
    ]);
    await first.close();
    await entry('three');

    const second = bus();
    second.consume('durable', handler);
    await drainUntil([second], () => batches.length >= 3);
    expect(batches.at(-1)).toEqual(['three']);
    const handled = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM handled WHERE consumer = 'durable'`.execute(t.db);
    expect(handled.rows[0]?.n).toBe(3);
    expect(metrics.registry.render()).toContain(
      'flagship_bus_events_total{consumer="durable",result="ok"} 3',
    );
    await second.close();
  });

  it('keeps delivering to other live handlers when one throws, and stops after unsubscribing', async () => {
    const b = bus(2);
    const good: string[] = [];
    const offBad = await b.on(() => {
      throw new Error('bad handler');
    });
    const offGood = await b.on((events) => {
      good.push(...events.map((e) => e.targetKey));
    });
    for (const key of ['l1', 'l2', 'l3', 'l4', 'l5']) await entry(key);
    await drainUntil([b], () => good.length >= 5);
    expect(good).toEqual(['l1', 'l2', 'l3', 'l4', 'l5']);
    offBad();
    offGood();
    offGood();
    await entry('after');
    await b.drain();
    expect(good).toHaveLength(5);
    // A handler registered later starts from the head, not from where the last
    // one left off. 'after' may still be behind the head if another transaction
    // on the server held the horizon back when the handler registered.
    const late: string[] = [];
    await b.on((events) => {
      late.push(...events.map((e) => e.targetKey));
    });
    await entry('late');
    await drainUntil([b], () => late.includes('late'));
    expect(late.filter((k) => k !== 'after')).toEqual(['late']);
    expect(t.logs.some((l) => l.includes('live event handler failed'))).toBe(true);
    await b.close();
    b.wake();
  });

  it('refuses bad or duplicate consumer names', () => {
    const b = bus();
    expect(() => {
      b.consume('Bad Name', () => Promise.resolve());
    }).toThrow(/invalid consumer name/);
    b.consume('webhooks', () => Promise.resolve());
    expect(() => {
      b.consume('webhooks', () => Promise.resolve());
    }).toThrow(/already registered/);
    void b.close();
  });

  it('catches up after the listener connection is lost, before the fallback poll', async () => {
    const seen: string[] = [];
    const off = await t.app.events.on((events) => {
      seen.push(...events.map((e) => e.targetKey));
    });
    await sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
              WHERE query LIKE 'LISTEN%' AND datname = current_database()
                AND pid <> pg_backend_pid()`.execute(t.db);
    await entry('while-down');
    // The listener reconnects after about a second and wakes the bus itself.
    await until(() => seen.includes('while-down'), 4000);
    off();
  });
});
