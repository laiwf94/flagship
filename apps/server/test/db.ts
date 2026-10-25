import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';

/** Creates an empty database on the shared test server, so test files can run in parallel. */
export async function createTestDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  const base = inject('postgresUrl');
  const name = `t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(base);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: async () => {
      const c = new pg.Client({ connectionString: base });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}
