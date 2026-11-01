import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase } from '../../test/db.js';
import { Migrator } from 'kysely/migration';
import { createDatabase, migrate, type Db } from './database.js';
import { migrations } from './migrations.js';

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
    expect(applied.map((r) => r.migrationName)).toEqual([
      '001_initial',
      '002_login_attempts',
      '003_flag_config_versions',
      '004_ruleset_change_checksums',
    ]);
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
      'login_attempts',
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
        'login_attempts_last_at_idx',
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

  it("backfill each environment's targeting version from the flag version", async () => {
    const fresh = await createTestDatabase();
    const { db: old } = createDatabase({ url: fresh.url });
    try {
      const migrator = new Migrator({
        db: old,
        provider: { getMigrations: () => Promise.resolve(migrations) },
      });
      const upTo = await migrator.migrateTo('002_login_attempts');
      expect(upTo.error).toBeUndefined();
      await sql`INSERT INTO projects (key, name) VALUES ('p', 'P')`.execute(old);
      await sql`INSERT INTO environments (project_id, key, name)
        SELECT id, e, e FROM projects, unnest(ARRAY['dev', 'prod']) AS e`.execute(old);
      await sql`INSERT INTO flags (project_id, key, name, type, variants, salt, version)
        SELECT id, f.key, f.key, 'boolean', '[]', f.key, f.version FROM projects,
          (VALUES ('fresh', 1), ('edited', 7)) AS f (key, version)`.execute(old);
      await sql`INSERT INTO flag_configs (environment_id, flag_id, off_variant, fallthrough)
        SELECT environments.id, flags.id, 'off', '{"variant":"off"}'
        FROM environments CROSS JOIN flags`.execute(old);

      await migrate(old);
      const rows = await sql<{ flag: string; env: string; version: number }>`
        SELECT flags.key AS flag, environments.key AS env, flag_configs.version
        FROM flag_configs
        JOIN flags ON flags.id = flag_configs.flag_id
        JOIN environments ON environments.id = flag_configs.environment_id
        ORDER BY 1, 2`.execute(old);
      expect(rows.rows).toEqual([
        { flag: 'edited', env: 'dev', version: 7 },
        { flag: 'edited', env: 'prod', version: 7 },
        { flag: 'fresh', env: 'dev', version: 1 },
        { flag: 'fresh', env: 'prod', version: 1 },
      ]);
      await expect(sql`UPDATE flag_configs SET version = 0`.execute(old)).rejects.toThrow(
        /check constraint/,
      );
    } finally {
      await old.destroy();
      await fresh.drop();
    }
  });

  it('accept only hex SHA-256 checksums on recorded changes, and none on older rows', async () => {
    await sql`INSERT INTO projects (key, name) VALUES ('sums', 'Sums')`.execute(db);
    await sql`INSERT INTO environments (project_id, key, name)
      SELECT id, 'prod', 'Prod' FROM projects WHERE key = 'sums'`.execute(db);
    const env = sql`(SELECT environments.id FROM environments
      JOIN projects ON projects.id = environments.project_id WHERE projects.key = 'sums')`;
    await sql`INSERT INTO ruleset_changes (environment_id, version, kind, key, value)
      VALUES (${env}, 1, 'flag', 'old', NULL)`.execute(db);
    await sql`INSERT INTO ruleset_changes (environment_id, version, kind, key, value, checksum)
      VALUES (${env}, 2, 'flag', 'new', NULL, ${'a'.repeat(64)})`.execute(db);
    await expect(
      sql`INSERT INTO ruleset_changes (environment_id, version, kind, key, value, checksum)
        VALUES (${env}, 3, 'flag', 'bad', NULL, ${'A'.repeat(64)})`.execute(db),
    ).rejects.toThrow(/check constraint/);
  });

  it('read bigint columns as numbers', async () => {
    const r = await sql<{ n: number }>`SELECT 9007199254740991::bigint AS n`.execute(db);
    expect(r.rows[0]?.n).toBe(Number.MAX_SAFE_INTEGER);
  });
});
