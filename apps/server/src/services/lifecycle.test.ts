import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApp, type TestApp } from '../../test/app.js';
import { PASSWORD, signIn, type Client } from '../../test/session.js';
import { isNotableTransition, lifecycleCheck } from './lifecycle.js';

const DAY = 86_400_000;
const P = '/api/projects/default';

let t: TestApp;
let key: string;
// Flags are created on the database clock; the app clock runs ahead of it on demand.
let offset = 0;
const now = () => new Date(Date.now() + offset);

beforeAll(async () => {
  t = await testApp(
    {
      bootstrapAdmin: { email: 'root@example.com', password: PASSWORD },
      eventsFlushMs: 3_600_000,
      // The scheduler's timer stays out of the way; the tests run the check themselves.
      schedulerIntervalMs: 3_600_000,
    },
    { now },
  );
  const admin = await client();
  key = (
    await admin.request('POST', `${P}/environments/production/api-keys`, {
      kind: 'server',
      name: 'api',
    })
  ).json().secret;
});
afterAll(() => t.close());

/** A fresh session, since moving the clock a month ahead expires the old one. */
const client = (): Promise<Client> => signIn(t.app.server, 'root@example.com');

async function evaluate(flags: string[], at?: number): Promise<void> {
  const res = await t.app.server.inject({
    method: 'POST',
    url: '/sdk/v1/events',
    headers: { authorization: `Bearer ${key}` },
    payload: { events: flags.map((flag) => ({ flag, variant: 'on', count: 3, at })) },
  });
  expect(res.statusCode, res.body).toBe(202);
  await t.app.exposures.flush();
}

async function target(c: Client, flag: string, change: Record<string, unknown>) {
  const current = (await c.request('GET', `${P}/flags/${flag}`)).json().environments.production;
  const res = await c.request('PUT', `${P}/flags/${flag}/environments/production`, {
    version: current.version,
    enabled: current.enabled,
    offVariant: current.offVariant,
    prerequisites: current.prerequisites,
    rules: current.rules,
    fallthrough: current.fallthrough,
    ...change,
  });
  expect(res.statusCode, res.body).toBe(200);
}

interface Summary {
  key: string;
  lifecycle: { stage: string; stale: boolean; reasons: { kind: string; variant?: string }[] };
  lastEvaluatedAt: string | null;
}

async function stages(c: Client, env = 'production'): Promise<Record<string, string>> {
  const res = await c.request('GET', `${P}/flags?environment=${env}`);
  expect(res.statusCode, res.body).toBe(200);
  return Object.fromEntries((res.json().flags as Summary[]).map((f) => [f.key, f.lifecycle.stage]));
}

interface Entry {
  action: string;
  actor: string;
  targetKey: string;
  environment: string | null;
  before: { stage: string | null };
  after: { stage: string; reasons: { kind: string }[] };
}

async function lifecycleEntries(c: Client): Promise<Entry[]> {
  const res = await c.request('GET', `${P}/audit?q=lifecycle&limit=200`);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json().entries as Entry[]).filter((e) => e.action === 'flag.lifecycle');
}

const check = (o: { batch?: number } = {}) =>
  lifecycleCheck({ db: t.db, metrics: t.app.metrics, logger: t.logger, ...o });

describe('flag lifecycle', () => {
  it('tracks the last evaluation per flag and environment, only moving forward', async () => {
    const c = await client();
    await c.request('POST', `${P}/flags`, { key: 'tracked', name: 'Tracked', type: 'boolean' });
    const at = now().getTime();
    await evaluate(['tracked'], at);
    await evaluate(['tracked'], at - 2 * DAY);
    const rows = await t.db
      .selectFrom('flag_evaluations')
      .select(['flag_key', 'last_evaluated_at'])
      .where('flag_key', '=', 'tracked')
      .execute();
    expect(rows).toEqual([
      { flag_key: 'tracked', last_evaluated_at: new Date(Math.floor(at / 3_600_000) * 3_600_000) },
    ]);
    const list = (await c.request('GET', `${P}/flags?environment=production&q=tracked`)).json();
    expect(list.flags[0].lastEvaluatedAt).toBe(rows[0]?.last_evaluated_at.toISOString());
    expect(list.flags[0].lifecycle).toEqual({ stage: 'active', stale: false, reasons: [] });
    const dev = (await c.request('GET', `${P}/flags?environment=development&q=tracked`)).json();
    expect(dev.flags[0]).toMatchObject({ lastEvaluatedAt: null, lifecycle: { stage: 'new' } });
  });

  it('marks launched and unevaluated flags stale with the reason, and the nightly check records it once', async () => {
    let c = await client();
    for (const k of ['fresh', 'rolled', 'busy']) {
      const res = await c.request('POST', `${P}/flags`, { key: k, name: k, type: 'boolean' });
      expect(res.statusCode, res.body).toBe(201);
    }
    await target(c, 'rolled', { enabled: true, fallthrough: { variant: 'on' } });
    await target(c, 'busy', {
      enabled: true,
      fallthrough: {
        rollout: {
          variants: [
            { variant: 'on', weight: 50_000 },
            { variant: 'off', weight: 50_000 },
          ],
        },
      },
    });
    await evaluate(['rolled', 'busy']);
    expect(await stages(c)).toMatchObject({ fresh: 'new', rolled: 'active', busy: 'active' });

    // A month later the code still asks for rolled and busy, and never asked for fresh.
    offset = 31 * DAY;
    c = await client();
    await evaluate(['rolled', 'busy', 'tracked']);
    expect(await stages(c)).toMatchObject({
      fresh: 'inactive',
      rolled: 'launched',
      busy: 'active',
    });

    const stale = await c.request('GET', `${P}/environments/production/stale-flags`);
    expect(stale.statusCode, stale.body).toBe(200);
    const body = stale.json<{
      staleAfterDays: number;
      flags: { key: string; stage: string; reasons: Record<string, unknown>[] }[];
    }>();
    expect(body.staleAfterDays).toBe(30);
    // Longest stale first: tracked has been switched off since the first test.
    expect(body.flags.map((f) => [f.key, f.stage])).toEqual([
      ['tracked', 'launched'],
      ['fresh', 'inactive'],
      ['rolled', 'launched'],
    ]);
    expect(body.flags[0]?.reasons).toEqual([
      { kind: 'launched', variant: 'off', enabled: false, since: expect.any(String) },
    ]);
    // Never turned on either, so both reasons hold.
    expect(body.flags[1]?.reasons).toEqual([
      { kind: 'unevaluated', lastEvaluatedAt: null, since: expect.any(String) },
      { kind: 'launched', variant: 'off', enabled: false, since: expect.any(String) },
    ]);
    expect(body.flags[2]?.reasons).toEqual([
      { kind: 'launched', variant: 'on', enabled: true, since: expect.any(String) },
    ]);

    const run = check();
    const before = (await lifecycleEntries(c)).length;
    const changed = await run(now());
    const rows = await t.db.selectFrom('flag_configs').select('flag_id').execute();
    expect(changed).toBe(rows.length);
    const all = await lifecycleEntries(c);
    const recorded = all.slice(0, all.length - before);
    const prod = recorded.filter((e) => e.environment === 'production');
    expect(prod.map((e) => [e.targetKey, e.before.stage, e.after.stage]).sort()).toEqual([
      ['fresh', null, 'inactive'],
      ['rolled', null, 'launched'],
      ['tracked', null, 'launched'],
    ]);
    expect(prod.every((e) => e.actor === 'Lifecycle check')).toBe(true);
    expect(t.app.metrics.registry.render()).toMatch(
      /flagship_flags_lifecycle\{stage="launched"\} 2\n/,
    );

    // Checked rows aren't due again for a day.
    expect(await run(now())).toBe(0);
    expect((await lifecycleEntries(c)).length).toBe(before + recorded.length);

    // A new rule makes rolled active again, and the next day's check says so.
    await target(c, 'rolled', {
      rules: [
        {
          id: 'staff',
          clauses: [{ attribute: 'email', operator: 'endsWith', values: ['@acme.com'] }],
          serve: { variant: 'off' },
        },
      ],
    });
    offset += DAY + 60_000;
    c = await client();
    await evaluate(['rolled', 'busy', 'tracked']);
    expect(await run(now())).toBeGreaterThanOrEqual(1);
    const latest = (await lifecycleEntries(c))[0];
    expect(latest).toMatchObject({
      targetKey: 'rolled',
      environment: 'production',
      before: { stage: 'launched' },
      after: { stage: 'active', reasons: [] },
    });
  });

  it('shares the check between instances so each row is classified once', async () => {
    const c = await client();
    await sql`UPDATE flag_configs SET lifecycle_stage = NULL, lifecycle_checked_at = NULL`.execute(
      t.db,
    );
    const before = (await lifecycleEntries(c)).length;
    const total = (await t.db.selectFrom('flag_configs').select('flag_id').execute()).length;
    const at = now();
    const [a, b] = await Promise.all([check({ batch: 2 })(at), check({ batch: 2 })(at)]);
    expect(a + b).toBe(total);
    const checked = await t.db
      .selectFrom('flag_configs')
      .select('lifecycle_checked_at')
      .where('lifecycle_checked_at', 'is', null)
      .execute();
    expect(checked).toEqual([]);
    const stale = await t.db
      .selectFrom('flag_configs')
      .select('flag_id')
      .where('lifecycle_stage', 'in', ['launched', 'inactive'])
      .execute();
    expect((await lifecycleEntries(c)).length).toBe(before + stale.length);
  });

  it('leaves archived flags out of the cleanup list and archiving out of the lifecycle entries', async () => {
    const c = await client();
    const flag = (await c.request('GET', `${P}/flags/fresh`)).json();
    const res = await c.request('POST', `${P}/flags/fresh/archive`, { version: flag.version });
    expect(res.statusCode, res.body).toBe(200);
    const stale = (await c.request('GET', `${P}/environments/production/stale-flags`)).json();
    expect(stale.flags.map((f: { key: string }) => f.key)).not.toContain('fresh');
    const archived = (
      await c.request('GET', `${P}/flags?environment=production&status=archived`)
    ).json();
    expect(archived.flags[0].lifecycle).toEqual({ stage: 'archived', stale: false, reasons: [] });

    const before = (await lifecycleEntries(c)).length;
    await sql`UPDATE flag_configs SET lifecycle_checked_at = NULL`.execute(t.db);
    await check()(now());
    const stages = await t.db
      .selectFrom('flag_configs')
      .innerJoin('flags', 'flags.id', 'flag_configs.flag_id')
      .select('flag_configs.lifecycle_stage')
      .where('flags.key', '=', 'fresh')
      .execute();
    expect(stages.map((s) => s.lifecycle_stage)).toEqual(['archived', 'archived']);
    expect((await lifecycleEntries(c)).length).toBe(before);
  });

  it('refuses unknown environments and anonymous callers', async () => {
    const c = await client();
    expect((await c.request('GET', `${P}/environments/nope/stale-flags`)).statusCode).toBe(404);
    const anon = await t.app.server.inject({
      method: 'GET',
      url: `${P}/environments/production/stale-flags`,
    });
    expect(anon.statusCode).toBe(401);
  });
});

describe('isNotableTransition', () => {
  it('records becoming stale and recovering, but not first sightings, archiving or no change', () => {
    expect(isNotableTransition(null, 'launched')).toBe(true);
    expect(isNotableTransition('active', 'inactive')).toBe(true);
    expect(isNotableTransition('launched', 'inactive')).toBe(true);
    expect(isNotableTransition('launched', 'active')).toBe(true);
    expect(isNotableTransition(null, 'new')).toBe(false);
    expect(isNotableTransition('new', 'active')).toBe(false);
    expect(isNotableTransition('inactive', 'archived')).toBe(false);
    expect(isNotableTransition('launched', 'launched')).toBe(false);
  });
});
