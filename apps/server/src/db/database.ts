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
  /**
   * Called when a pooled connection dies between queries (database restart,
   * failover, a terminated backend), whether it was idle in the pool or
   * checked out, for example in the middle of a transaction.
   */
  onConnectionError?: (err: Error) => void;
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
  const report = (err: Error) => {
    options.onConnectionError?.(err);
  };
  // pg emits 'error' on a client whose connection is cut while no query is
  // running on it. Unhandled, that event crashes the process. The pool
  // listens only while a client is idle and forwards that as 'error' here;
  // a checked-out client, say between the statements of a transaction, has
  // no listener, so add one for as long as it is out. Its next query fails,
  // and on release the pool sees it is no longer queryable and drops it.
  pool.on('error', report);
  pool.on('acquire', (client) => {
    client.on('error', report);
  });
  pool.on('release', (_err, client) => {
    client.removeListener('error', report);
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
