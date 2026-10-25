import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase } from '../../test/db.js';
import { createDatabase, migrate, type Db } from './database.js';

let drop: () => Promise<void>;
let url: string;
let db: Db;

beforeAll(async () => {
  ({ url, drop } = await createTestDatabase());
  ({ db } = createDatabase({ url }));
});

afterAll(async () => {
  await db.destroy();
  await drop();
});

describe('migrations', () => {
  it('apply concurrently without racing, then are a no-op', async () => {
    const others = [createDatabase({ url }).db, createDatabase({ url }).db];
    const results = await Promise.all([db, ...others].map((d) => migrate(d)));
    const applied = results.flatMap((r) => r.results ?? []).filter((r) => r.status === 'Success');
    expect(applied.map((r) => r.migrationName)).toEqual(['001_initial']);
    await Promise.all(others.map((d) => d.destroy()));

    const again = await migrate(db);
    expect(again.results).toEqual([]);
  });

  it('create the expected tables and indexes', async () => {
    const tables = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name NOT LIKE 'kysely%' ORDER BY table_name`.execute(
      db,
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual([
      'api_keys',
      'audit_log',
      'environments',
      'exposure_counts',
      'flag_configs',
      'flags',
      'projects',
      'ruleset_changes',
      'scheduled_changes',
      'segments',
      'sessions',
      'users',
    ]);
    const indexes = await sql<{ indexname: string }>`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname`.execute(db);
    expect(indexes.rows.map((r) => r.indexname)).toEqual(
      expect.arrayContaining([
        'audit_log_project_idx',
        'audit_log_target_idx',
        'scheduled_changes_due_idx',
        'sessions_expires_idx',
        'api_keys_key_hash_key',
      ]),
    );
  });

  it('enforce constraints the application relies on', async () => {
    await expect(
      db
        .insertInto('users')
        .values({ email: 'Alice@Example.com', name: 'A', password_hash: 'x', role: 'admin' })
        .execute(),
    ).rejects.toThrow(/check constraint/);
    await expect(
      db
        .insertInto('users')
        .values({ email: 'a@example.com', name: 'A', password_hash: 'x', role: 'root' as never })
        .execute(),
    ).rejects.toThrow(/check constraint/);
  });

  it('survives idle connections being cut', async () => {
    const errors: Error[] = [];
    const own = createDatabase({ url, onIdleError: (e) => errors.push(e) });
    await sql`SELECT 1`.execute(own.db);
    await sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
              WHERE datname = current_database() AND pid <> pg_backend_pid()
              AND application_name = ''`.execute(db);
    for (let i = 0; i < 50 && errors.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(errors.length).toBeGreaterThan(0);
    const r = await sql<{ n: number }>`SELECT 1 AS n`.execute(own.db);
    expect(r.rows[0]?.n).toBe(1);
    await own.db.destroy();
    await sql`SELECT 1`.execute(db);
  });

  it('read bigint columns as numbers', async () => {
    const r = await sql<{ n: number }>`SELECT 9007199254740991::bigint AS n`.execute(db);
    expect(r.rows[0]?.n).toBe(Number.MAX_SAFE_INTEGER);
  });
});
