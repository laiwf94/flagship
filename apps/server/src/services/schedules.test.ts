import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createDatabase } from '../db/database.js';
import { createLogger } from '../log.js';
import { testApp, type TestApp } from '../../test/app.js';
import { PASSWORD, signIn, userWithRole, type Client } from '../../test/session.js';

let t: TestApp;
let editor: Client;
let viewer: Client;
let clock = new Date('2030-06-01T09:00:00Z');

const P = '/api/projects/default';
const S = (flag: string) => `${P}/flags/${flag}/environments/production/schedules`;
const later = (minutes: number) => new Date(clock.getTime() + minutes * 60_000).toISOString();

async function flag(key: string) {
  return (await editor.request('GET', `${P}/flags/${key}`)).json();
}

beforeAll(async () => {
  t = await testApp(
    {
      bootstrapAdmin: { email: 'root@example.com', password: PASSWORD },
      schedulerIntervalMs: 3_600_000,
    },
    { now: () => clock },
  );
  await signIn(t.app.server, 'root@example.com');
  editor = await userWithRole(t.app.server, t.db, 'eddie@example.com', 'editor');
  viewer = await userWithRole(t.app.server, t.db, 'vera@example.com', 'viewer');
  for (const key of ['launch', 'ramp', 'doomed', 'cancel-me', 'race']) {
    await editor.request('POST', `${P}/flags`, { key, name: key, type: 'boolean' });
  }
});
afterAll(() => t.close());

describe('scheduled changes', () => {
  it('turns a flag on at the scheduled time through the normal audited path', async () => {
    const created = await editor.request('POST', S('launch'), {
      runAt: later(30),
      change: { enabled: true, fallthrough: { variant: 'on' } },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({ status: 'pending', createdBy: 'eddie' });
    const before = await flag('launch');

    expect(await t.app.scheduler.runOnce()).toBe(0);
    clock = new Date(clock.getTime() + 31 * 60_000);
    expect(await t.app.scheduler.runOnce()).toBe(1);

    const after = await flag('launch');
    expect(after.environments.production).toMatchObject({
      enabled: true,
      fallthrough: { variant: 'on' },
    });
    expect(after.version).toBe(before.version + 1);
    const list = (await viewer.request('GET', S('launch'))).json().schedules;
    expect(list[0]).toMatchObject({ status: 'applied', error: null });
    const audit = (await viewer.request('GET', `${P}/audit?flag=launch&limit=1`)).json().entries[0];
    expect(audit).toMatchObject({ action: 'flag.schedule.apply', actor: 'Scheduled by eddie' });
    expect(t.app.metrics.schedules.get({ result: 'applied' })).toBe(1);
  });

  it('marks a change failed, with the reason, when it no longer validates', async () => {
    const created = await editor.request('POST', S('doomed'), {
      runAt: later(5),
      change: {
        rules: [
          {
            id: 'beta',
            clauses: [{ operator: 'inSegment', segments: ['beta'] }],
            serve: { variant: 'on' },
          },
        ],
      },
    });
    expect(created.statusCode).toBe(400);

    await editor.request('POST', `${P}/environments/production/segments`, {
      key: 'beta',
      name: 'Beta',
      included: ['alice'],
      excluded: [],
      rules: [],
    });
    const ok = await editor.request('POST', S('doomed'), {
      runAt: later(5),
      change: {
        enabled: true,
        rules: [
          {
            id: 'beta',
            clauses: [{ operator: 'inSegment', segments: ['beta'] }],
            serve: { variant: 'on' },
          },
        ],
      },
    });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(
      (await editor.request('DELETE', `${P}/environments/production/segments/beta?version=1`))
        .statusCode,
    ).toBe(204);
    const before = await flag('doomed');
    clock = new Date(clock.getTime() + 6 * 60_000);
    expect(await t.app.scheduler.runOnce()).toBe(1);
    const after = await flag('doomed');
    expect(after.version).toBe(before.version);
    expect(after.environments.production.enabled).toBe(false);
    const row = (await viewer.request('GET', S('doomed'))).json().schedules[0];
    expect(row.status).toBe('failed');
    expect(row.error).toContain('unknown segment "beta"');
  });

  it('can be cancelled before it runs', async () => {
    const created = (
      await editor.request('POST', S('cancel-me'), { runAt: later(10), change: { enabled: true } })
    ).json();
    const cancelled = await editor.request('DELETE', `${S('cancel-me')}/${created.id}`);
    expect(cancelled.json().status).toBe('cancelled');
    expect((await editor.request('DELETE', `${S('cancel-me')}/${created.id}`)).statusCode).toBe(
      404,
    );
    clock = new Date(clock.getTime() + 11 * 60_000);
    expect(await t.app.scheduler.runOnce()).toBe(0);
    expect((await flag('cancel-me')).environments.production.enabled).toBe(false);
  });

  it('is applied once when two workers race for it', async () => {
    await editor.request('POST', S('race'), { runAt: later(1), change: { enabled: true } });
    clock = new Date(clock.getTime() + 2 * 60_000);
    const { db } = createDatabase({ url: t.url, maxConnections: 5 });
    const other = await buildApp({
      config: t.config,
      db,
      logger: createLogger('silent'),
      now: () => clock,
    });
    try {
      const [a, b] = await Promise.all([t.app.scheduler.runOnce(), other.scheduler.runOnce()]);
      expect(a + b).toBe(1);
      const applies = (await viewer.request('GET', `${P}/audit?flag=race`))
        .json()
        .entries.filter((e: { action: string }) => e.action === 'flag.schedule.apply');
      expect(applies).toHaveLength(1);
    } finally {
      await other.close();
      await db.destroy();
    }
  });

  it('validates input and permissions', async () => {
    const past = await editor.request('POST', S('ramp'), {
      runAt: later(-1),
      change: { enabled: true },
    });
    expect(past.json().error.details).toEqual([
      { path: 'runAt', message: 'must be in the future' },
    ]);
    const far = await editor.request('POST', S('ramp'), {
      runAt: later(60 * 24 * 400),
      change: { enabled: true },
    });
    expect(far.statusCode).toBe(400);
    const empty = await editor.request('POST', S('ramp'), { runAt: later(5), change: {} });
    expect(empty.statusCode).toBe(400);
    const notIso = await editor.request('POST', S('ramp'), {
      runAt: 'tomorrow',
      change: { enabled: true },
    });
    expect(notIso.statusCode).toBe(400);
    const denied = await viewer.request('POST', S('ramp'), {
      runAt: later(5),
      change: { enabled: true },
    });
    expect(denied.statusCode).toBe(403);
    expect((await viewer.request('GET', S('ghost'))).statusCode).toBe(404);
  });

  it('cancels pending changes when the flag is archived', async () => {
    await editor.request('POST', S('ramp'), { runAt: later(5), change: { enabled: true } });
    await editor.request('POST', `${P}/flags/ramp/archive`, {
      version: (await flag('ramp')).version,
    });
    const rows = (await viewer.request('GET', S('ramp'))).json().schedules;
    expect(rows[0]).toMatchObject({ status: 'cancelled', error: 'flag was archived' });
    const onArchived = await editor.request('POST', S('ramp'), {
      runAt: later(5),
      change: { enabled: true },
    });
    expect(onArchived.statusCode).toBe(400);
  });

  it('runs on its own timer', async () => {
    const quick = await testApp({
      bootstrapAdmin: { email: 'a@example.com', password: PASSWORD },
      schedulerIntervalMs: 100,
    });
    try {
      const c = await signIn(quick.app.server, 'a@example.com');
      await c.request('POST', `${P}/flags`, { key: 'auto', name: 'auto', type: 'boolean' });
      const runAt = new Date(Date.now() + 300).toISOString();
      const res = await c.request('POST', `${P}/flags/auto/environments/production/schedules`, {
        runAt,
        change: { enabled: true },
      });
      expect(res.statusCode, res.body).toBe(201);
      const deadline = Date.now() + 5000;
      for (;;) {
        const f = (await c.request('GET', `${P}/flags/auto`)).json();
        if (f.environments.production.enabled === true) break;
        if (Date.now() > deadline) throw new Error('scheduler never ran');
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      await quick.close();
    }
  });
});
