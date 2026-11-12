import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Db } from '../db/database.js';
import { testApp, type TestApp } from '../../test/app.js';
import { PASSWORD } from '../../test/session.js';
import { recordAudit } from './audit.js';
import { lockEnvironments } from './rulesets.js';

let t: TestApp;
let other: Db;
let env: { id: string; project_id: string };

beforeAll(async () => {
  t = await testApp({ bootstrapAdmin: { email: 'root@example.com', password: PASSWORD } });
  other = createDatabase({ url: t.url, maxConnections: 2 }).db;
  env = await t.db
    .selectFrom('environments')
    .select(['id', 'project_id'])
    .where('key', '=', 'production')
    .executeTakeFirstOrThrow();
});
afterAll(async () => {
  await other.destroy();
  await t.close();
});

describe('lockEnvironments', () => {
  it('serialises writers of one environment', async () => {
    const holder = await t.db.startTransaction().execute();
    try {
      await lockEnvironments(holder, [env.id]);
      const waiter = await other.startTransaction().execute();
      try {
        await sql`SET LOCAL lock_timeout = '300ms'`.execute(waiter);
        await expect(lockEnvironments(waiter, [env.id])).rejects.toThrow(/lock timeout/);
      } finally {
        await waiter.rollback().execute();
      }
    } finally {
      await holder.rollback().execute();
    }
  });

  it('does not block an audit entry for the environment while it is held', async () => {
    // The lifecycle check holds flag_configs rows and then records audit
    // entries; a targeting write holds the environment and then updates those
    // rows. If the entry's foreign key check waited on the environment lock,
    // the two would deadlock.
    const holder = await t.db.startTransaction().execute();
    try {
      await lockEnvironments(holder, [env.id]);
      const writer = await other.startTransaction().execute();
      try {
        await sql`SET LOCAL lock_timeout = '2s'`.execute(writer);
        await recordAudit(writer, {
          projectId: env.project_id,
          environmentId: env.id,
          actor: { id: null, name: 'test' },
          action: 'flag.lifecycle',
          targetType: 'flag',
          targetKey: 'any',
        });
      } finally {
        await writer.rollback().execute();
      }
    } finally {
      await holder.rollback().execute();
    }
  });
});
