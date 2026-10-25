import { Kysely, PostgresDialect } from 'kysely';
import { Migrator, type MigrationResultSet } from 'kysely/migration';
import pg from 'pg';
import { migrations } from './migrations.js';
import type { Database } from './schema.js';

// bigint columns hold versions and counters that stay far below 2^53.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number.parseInt(v, 10));

export type Db = Kysely<Database>;

export interface DatabaseOptions {
  url: string;
  maxConnections?: number;
  /** Called when an idle pooled connection dies (database restart, failover). */
  onIdleError?: (err: Error) => void;
}

export function createDatabase(options: DatabaseOptions): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool({
    connectionString: options.url,
    max: options.maxConnections ?? 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // Keeps a stuck query from holding a pooled connection forever.
    statement_timeout: 15_000,
  });
  // pg emits 'error' when an idle connection is cut. Unhandled, that event
  // would crash the process; the pool already drops the dead client and
  // opens a new one on the next query.
  pool.on('error', (err) => {
    options.onIdleError?.(err);
  });
  return { db: new Kysely<Database>({ dialect: new PostgresDialect({ pool }) }), pool };
}

/**
 * Applies pending migrations. Kysely's Postgres adapter takes a transaction
 * scoped advisory lock first, so servers starting together queue up instead
 * of racing.
 */
export async function migrate(db: Db): Promise<MigrationResultSet> {
  const migrator = new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(migrations) },
  });
  const result = await migrator.migrateToLatest();
  if (result.error !== undefined) {
    throw result.error instanceof Error
      ? result.error
      : new Error('migration failed', { cause: result.error });
  }
  return result;
}
