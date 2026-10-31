import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase } from '../../test/db.js';
import { addUser, PASSWORD } from '../../test/session.js';
import { buildApp, type App } from '../app.js';
import { loadConfig } from '../config.js';
import { createDatabase, migrate, type Db } from '../db/database.js';
import { createLogger } from '../log.js';
import { SignInLimiter } from './ratelimit.js';

// Two server instances, each with its own connection pool, on one database:
// the budget has to be shared between them.
let drop: () => Promise<void>;
let dbs: Db[] = [];
let a: App;
let b: App;
let clock = new Date('2030-01-01T00:00:00Z');
const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};

beforeAll(async () => {
  const created = await createTestDatabase();
  drop = created.drop;
  dbs = [createDatabase({ url: created.url }).db, createDatabase({ url: created.url }).db];
  await migrate(dbs[0]!);
  // The scheduler's timer stays out of the way; tests drive housekeeping themselves.
  const config = {
    ...loadConfig({ FLAGSHIP_DATABASE_URL: created.url }),
    schedulerIntervalMs: 3_600_000,
  };
  const logger = createLogger('silent');
  const build = (db: Db) => buildApp({ config, db, logger, now: () => clock });
  a = await build(dbs[0]!);
  b = await build(dbs[1]!);
  await addUser(dbs[0]!, 'target@example.com', 'viewer');
  await addUser(dbs[0]!, 'other@example.com', 'viewer');
});

afterAll(async () => {
  await a.close();
  await b.close();
  await Promise.all(dbs.map((db) => db.destroy()));
  await drop();
});

beforeEach(async () => {
  await sql`TRUNCATE login_attempts`.execute(dbs[0]!);
  advance(60 * 60_000);
});

function attempt(app: App, email: string, password: string, ip = '10.0.0.1') {
  return app.server.inject({
    method: 'POST',
    url: '/api/session',
    payload: { email, password },
    remoteAddress: ip,
  });
}

async function rows() {
  return dbs[0]!
    .selectFrom('login_attempts')
    .select(['scope', 'key', sql<number>`cardinality(attempts)`.as('n')])
    .orderBy('scope')
    .orderBy('key')
    .execute();
}

describe('shared sign-in limiter', () => {
  it('shares the per-email budget between instances', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await attempt(a, 'target@example.com', 'wrong')).statusCode).toBe(401);
      expect((await attempt(b, 'target@example.com', 'wrong')).statusCode).toBe(401);
    }
    for (const app of [a, b]) {
      const blocked = await attempt(app, 'target@example.com', PASSWORD, '10.0.0.2');
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().error.code).toBe('resource_exhausted');
      expect(Number(blocked.headers['retry-after'])).toBe(15 * 60);
    }
    advance(15 * 60_000 + 1);
    expect((await attempt(b, 'target@example.com', PASSWORD)).statusCode).toBe(200);
  });

  it('counts concurrent guesses on both instances exactly once each', async () => {
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        attempt(i % 2 === 0 ? a : b, 'target@example.com', 'wrong', `10.0.1.${i}`),
      ),
    );
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 401)).toHaveLength(10);
    expect(codes.filter((c) => c === 429)).toHaveLength(20);
  });

  it('shares the per-address budget between instances', async () => {
    for (let i = 0; i < 50; i++) {
      const app = i % 2 === 0 ? a : b;
      expect((await attempt(app, `nobody${i}@example.com`, 'wrong')).statusCode).toBe(401);
    }
    const blocked = await attempt(b, 'other@example.com', PASSWORD);
    expect(blocked.statusCode).toBe(429);
    // Refused by the address, so the email's budget was not touched.
    expect(await rows()).not.toContainEqual(expect.objectContaining({ key: 'other@example.com' }));
    expect((await attempt(a, 'other@example.com', PASSWORD, '10.0.0.9')).statusCode).toBe(200);
  });

  it('does not extend a lockout while a locked key keeps being tried', async () => {
    for (let i = 0; i < 10; i++) await attempt(a, 'target@example.com', 'wrong');
    for (let i = 0; i < 5; i++) {
      advance(60_000);
      expect((await attempt(b, 'target@example.com', 'wrong')).statusCode).toBe(429);
    }
    const blocked = await attempt(a, 'target@example.com', PASSWORD);
    expect(Number(blocked.headers['retry-after'])).toBe(10 * 60);
    advance(10 * 60_000);
    expect((await attempt(a, 'target@example.com', PASSWORD)).statusCode).toBe(200);
  });

  it('slides the window instead of resetting it', async () => {
    for (let i = 0; i < 5; i++) await attempt(a, 'target@example.com', 'wrong');
    advance(10 * 60_000);
    for (let i = 0; i < 5; i++) await attempt(b, 'target@example.com', 'wrong');
    expect((await attempt(a, 'target@example.com', PASSWORD)).statusCode).toBe(429);
    // The first five leave the window; the last five still count.
    advance(5 * 60_000 + 1);
    expect((await attempt(a, 'target@example.com', 'wrong')).statusCode).toBe(401);
    expect(await rows()).toContainEqual({ scope: 'email', key: 'target@example.com', n: 6 });
  });

  it('clears the email budget on success and only counts failures per address', async () => {
    for (let i = 0; i < 9; i++) await attempt(a, 'target@example.com', 'wrong');
    expect((await attempt(b, 'target@example.com', PASSWORD)).statusCode).toBe(200);
    expect(await rows()).toEqual([{ scope: 'ip', key: '10.0.0.1', n: 9 }]);
    for (let i = 0; i < 60; i++) {
      expect((await attempt(i % 2 ? a : b, 'other@example.com', PASSWORD)).statusCode).toBe(200);
    }
    expect(await rows()).toEqual([{ scope: 'ip', key: '10.0.0.1', n: 9 }]);
  });

  it('prunes expired rows in bounded batches from the scheduler', async () => {
    await attempt(a, 'target@example.com', 'wrong', '10.0.2.1');
    advance(10 * 60_000);
    await attempt(a, 'other@example.com', 'wrong', '10.0.2.2');
    advance(5 * 60_000);
    const limiter = new SignInLimiter(dbs[0]!);
    expect(await limiter.prune(clock, 1)).toBe(1);
    expect(await limiter.prune(clock, 1)).toBe(1);
    expect(await limiter.prune(clock, 1)).toBe(0);
    expect((await rows()).map((r) => r.key)).toEqual(['other@example.com', '10.0.2.2']);

    advance(10 * 60_000);
    await a.scheduler.housekeep();
    expect(await rows()).toEqual([]);
  });

  it('fails closed with 503 when the shared budget is unavailable', async () => {
    await sql`ALTER TABLE login_attempts RENAME TO login_attempts_away`.execute(dbs[0]!);
    try {
      for (const app of [a, b]) {
        const res = await attempt(app, 'target@example.com', PASSWORD);
        expect(res.statusCode).toBe(503);
        expect(res.json().error.code).toBe('unavailable');
        expect(res.headers['retry-after']).toBe('5');
        expect(res.headers['set-cookie']).toBeUndefined();
      }
      // A broken housekeeping job is logged, not thrown into the scheduler.
      advance(60_000);
      await expect(a.scheduler.runOnce()).resolves.toBe(0);
    } finally {
      await sql`ALTER TABLE login_attempts_away RENAME TO login_attempts`.execute(dbs[0]!);
    }
    expect((await attempt(a, 'target@example.com', PASSWORD)).statusCode).toBe(200);
  });
});
