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
      '005_change_requests',
      '006_segment_change_requests',
      '007_audit_search',
      '008_audit_snapshots',
      '009_flag_lifecycle',
      '010_rollout_plans',
      '011_experiment_events',
      '012_experiment_rollups',
      '013_experiments',
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
      'change_request_reviews',
      'change_requests',
      'conversion_events',
      'environments',
      'experiment_exposures',
      'experiment_rollup_conversions',
      'experiment_rollup_dirty',
      'experiment_rollup_exposures',
      'experiment_rollup_pending',
      'experiments',
      'exposure_counts',
      'flag_configs',
      'flag_evaluations',
      'flags',
      'login_attempts',
      'projects',
      'rollout_plans',
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
        'audit_log_actor_idx',
        'audit_log_project_idx',
        'audit_log_search_idx',
        'audit_log_target_idx',
        'change_request_reviews_request_idx',
        'change_requests_project_idx',
        'change_requests_segment_idx',
        'change_requests_target_idx',
        'conversion_events_context_idx',
        'conversion_events_pkey',
        'experiment_exposures_context_idx',
        'experiment_exposures_hour_idx',
        'experiment_exposures_pkey',
        'experiment_rollup_conversions_pkey',
        'experiment_rollup_dirty_pkey',
        'experiment_rollup_dirty_slice_idx',
        'experiment_rollup_exposures_pkey',
        'experiment_rollup_pending_pkey',
        'experiments_project_idx',
        'experiments_project_id_key_key',
        'experiments_running_idx',
        'flag_configs_lifecycle_due_idx',
        'flag_evaluations_pkey',
        'login_attempts_last_at_idx',
        'rollout_plans_due_idx',
        'rollout_plans_flag_idx',
        'rollout_plans_live_idx',
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
    const project = await db
      .insertInto('projects')
      .values({ key: 'constraints', name: 'C' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await expect(
      db
        .insertInto('environments')
        .values({ project_id: project.id, key: 'prod', name: 'P', required_approvals: 6 })
        .execute(),
    ).rejects.toThrow(/check constraint/);
  });

  it('give every change request exactly one target, and version 0 only to segments', async () => {
    await sql`INSERT INTO projects (key, name) VALUES ('targets', 'T')`.execute(db);
    await sql`INSERT INTO environments (project_id, key, name)
      SELECT id, 'prod', 'Prod' FROM projects WHERE key = 'targets'`.execute(db);
    await sql`INSERT INTO flags (project_id, key, name, type, variants, salt)
      SELECT id, 'f', 'f', 'boolean', '[]', 'f' FROM projects WHERE key = 'targets'`.execute(db);
    const insert = (flag: boolean, segment: string | null, baseVersion: number) =>
      sql`INSERT INTO change_requests (project_id, environment_id, flag_id, segment_key, title,
          base_version, base, proposed, author_name)
        SELECT projects.id, environments.id, ${flag ? sql`flags.id` : null}, ${segment}, 't',
          ${baseVersion}, 'null', 'null', 'a'
        FROM projects JOIN environments ON environments.project_id = projects.id
          JOIN flags ON flags.project_id = projects.id
        WHERE projects.key = 'targets'`.execute(db);
    await insert(true, null, 1);
    await insert(false, 'beta', 0);
    await expect(insert(true, 'beta', 1)).rejects.toThrow(/change_requests_one_target/);
    await expect(insert(false, null, 1)).rejects.toThrow(/change_requests_one_target/);
    await expect(insert(true, null, 0)).rejects.toThrow(/change_requests_base_version_check/);
    await expect(insert(false, 'beta', -1)).rejects.toThrow(/change_requests_base_version_check/);
  });

  it('index audit text for search and check reasons and links', async () => {
    const insert = (reason: string | null, link: string | null) =>
      sql`INSERT INTO audit_log (actor_name, action, target_type, target_key, reason, link)
        VALUES ('Dana', 'flag.kill_switch', 'flag', 'checkout-v2', ${reason}, ${link})`.execute(db);
    await insert('Rollback after INC-42 latency', 'https://tickets.example.com/INC-42');
    const hit = (query: string) =>
      sql<{ n: number }>`SELECT count(*)::int AS n FROM audit_log
        WHERE search @@ websearch_to_tsquery('simple', ${query})`.execute(db);
    for (const q of ['latency', 'checkout', '"checkout v2"', 'dana', '"inc 42"', 'kill switch']) {
      expect((await hit(q)).rows[0]?.n, q).toBe(1);
    }
    expect((await hit('latency -dana')).rows[0]?.n).toBe(0);
    await expect(insert('', null)).rejects.toThrow(/audit_log_reason_check/);
    await expect(insert(null, 'ftp://x')).rejects.toThrow(/audit_log_link_check/);
    await expect(insert('x'.repeat(1001), null)).rejects.toThrow(/audit_log_reason_check/);
  });

  it('survives idle connections being cut', async () => {
    const errors: Error[] = [];
    const own = createDatabase({ url, onConnectionError: (e) => errors.push(e) });
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

  it('survives a checked-out connection being cut between statements of a transaction', async () => {
    const errors: Error[] = [];
    const own = createDatabase({
      url,
      maxConnections: 1,
      onConnectionError: (e) => errors.push(e),
    });
    const outcome = own.db.transaction().execute(async (trx) => {
      const { rows } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx);
      await sql`SELECT pg_terminate_backend(${rows[0]!.pid})`.execute(db);
      // The FATAL arrives while no query is running on this client.
      for (let i = 0; i < 50 && errors.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      await sql`SELECT 1`.execute(trx);
    });
    await expect(outcome).rejects.toThrow();
    expect(errors.length).toBeGreaterThan(0);
    // The dead client was dropped, so the pool's only slot works again.
    const r = await sql<{ n: number }>`SELECT 1 AS n`.execute(own.db);
    expect(r.rows[0]?.n).toBe(1);
    await own.db.destroy();
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

  it('mark earlier entries that changed live state as restorable snapshots', async () => {
    const fresh = await createTestDatabase();
    const { db: old } = createDatabase({ url: fresh.url });
    try {
      const migrator = new Migrator({
        db: old,
        provider: { getMigrations: () => Promise.resolve(migrations) },
      });
      expect((await migrator.migrateTo('007_audit_search')).error).toBeUndefined();
      const actions = [
        ['flag.create', 'flag'],
        ['flag.update', 'flag'],
        ['flag.archive', 'flag'],
        ['flag.config.update', 'flag'],
        ['flag.kill_switch', 'flag'],
        ['flag.schedule.apply', 'flag'],
        ['flag.change_request.open', 'flag'],
        ['flag.change_request.apply', 'flag'],
        ['segment.create', 'segment'],
        ['segment.delete', 'segment'],
        ['segment.change_request.approve', 'segment'],
        ['segment.change_request.apply', 'segment'],
        ['api_key.create', 'api_key'],
      ];
      for (const [action, type] of actions) {
        await sql`INSERT INTO audit_log (actor_name, action, target_type, target_key)
          VALUES ('x', ${action}, ${type}, 'k')`.execute(old);
      }
      await migrate(old);
      const rows = await sql<{ action: string; snapshot: string | null }>`
        SELECT action, snapshot FROM audit_log ORDER BY id`.execute(old);
      expect(Object.fromEntries(rows.rows.map((r) => [r.action, r.snapshot]))).toEqual({
        'flag.create': 'flag',
        'flag.update': 'flag',
        'flag.archive': null,
        'flag.config.update': 'targeting',
        'flag.kill_switch': 'targeting',
        'flag.schedule.apply': 'targeting',
        'flag.change_request.open': null,
        'flag.change_request.apply': 'targeting',
        'segment.create': 'segment',
        'segment.delete': 'segment',
        'segment.change_request.approve': null,
        'segment.change_request.apply': 'segment',
        'api_key.create': null,
      });
      await expect(sql`UPDATE audit_log SET snapshot = 'project'`.execute(old)).rejects.toThrow(
        /check constraint/,
      );
    } finally {
      await old.destroy();
      await fresh.drop();
    }
  });

  it('backfill when each flag was last evaluated from the stored exposure counts', async () => {
    const fresh = await createTestDatabase();
    const { db: old } = createDatabase({ url: fresh.url });
    try {
      const migrator = new Migrator({
        db: old,
        provider: { getMigrations: () => Promise.resolve(migrations) },
      });
      expect((await migrator.migrateTo('008_audit_snapshots')).error).toBeUndefined();
      await sql`INSERT INTO projects (key, name) VALUES ('p', 'P')`.execute(old);
      await sql`INSERT INTO environments (project_id, key, name)
        SELECT id, e, e FROM projects, unnest(ARRAY['dev', 'prod']) AS e`.execute(old);
      await sql`INSERT INTO exposure_counts (environment_id, flag_key, hour, variant, count)
        SELECT environments.id, c.flag, c.hour::timestamptz, c.variant, 1
        FROM environments, (VALUES
          ('dev', 'checkout', '2030-01-01T10:00:00Z', 'on'),
          ('dev', 'checkout', '2030-01-03T07:00:00Z', 'off'),
          ('prod', 'checkout', '2030-01-02T00:00:00Z', 'on'),
          ('prod', 'search', '2030-01-01T00:00:00Z', 'a')
        ) AS c (env, flag, hour, variant)
        WHERE environments.key = c.env`.execute(old);
      await migrate(old);
      const rows = await sql<{ env: string; flag_key: string; last_evaluated_at: Date }>`
        SELECT environments.key AS env, flag_key, last_evaluated_at FROM flag_evaluations
        JOIN environments ON environments.id = environment_id ORDER BY 1, 2`.execute(old);
      expect(rows.rows.map((r) => [r.env, r.flag_key, r.last_evaluated_at.toISOString()])).toEqual([
        ['dev', 'checkout', '2030-01-03T07:00:00.000Z'],
        ['prod', 'checkout', '2030-01-02T00:00:00.000Z'],
        ['prod', 'search', '2030-01-01T00:00:00.000Z'],
      ]);
      await sql`INSERT INTO flags (project_id, key, name, type, variants, salt)
        SELECT id, 'checkout', 'c', 'boolean', '[]', 'c' FROM projects`.execute(old);
      await sql`INSERT INTO flag_configs (environment_id, flag_id, off_variant, fallthrough)
        SELECT environments.id, flags.id, 'off', '{"variant":"off"}' FROM environments, flags`.execute(
        old,
      );
      const stages = await sql<{ lifecycle_stage: string | null }>`
        SELECT lifecycle_stage FROM flag_configs`.execute(old);
      expect(stages.rows).toEqual([{ lifecycle_stage: null }, { lifecycle_stage: null }]);
      await sql`UPDATE flag_configs SET lifecycle_stage = 'launched'`.execute(old);
      await expect(
        sql`UPDATE flag_configs SET lifecycle_stage = 'stale'`.execute(old),
      ).rejects.toThrow(/check constraint/);
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
