import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApp, type TestApp } from '../../test/app.js';
import { PASSWORD, userWithRole, type Client } from '../../test/session.js';

let t: TestApp;
let editor: Client;
let viewer: Client;

const P = '/api/projects/default';
const target = (flag: string, env = 'production') => `${P}/flags/${flag}/environments/${env}`;

beforeAll(async () => {
  t = await testApp({ bootstrapAdmin: { email: 'root@example.com', password: PASSWORD } });
  editor = await userWithRole(t.app.server, t.db, 'eddie@example.com', 'editor');
  viewer = await userWithRole(t.app.server, t.db, 'vera@example.com', 'viewer');
});
afterAll(() => t.close());

async function auditCount(): Promise<number> {
  const r = await t.db
    .selectFrom('audit_log')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirstOrThrow();
  return r.n;
}

async function rulesetVersion(env = 'production'): Promise<number> {
  const r = await t.db
    .selectFrom('environments')
    .select('ruleset_version')
    .where('key', '=', env)
    .executeTakeFirstOrThrow();
  return r.ruleset_version;
}

async function create(key: string, extra: Record<string, unknown> = {}) {
  const res = await editor.request('POST', `${P}/flags`, {
    key,
    name: key,
    type: 'boolean',
    ...extra,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

describe('flags', () => {
  it('creates a boolean flag, off in every environment, and records one change per environment', async () => {
    const before = { prod: await rulesetVersion(), dev: await rulesetVersion('development') };
    const flag = await create('new-checkout', {
      description: 'One-page checkout',
      clientSide: true,
    });
    expect(flag).toMatchObject({
      key: 'new-checkout',
      type: 'boolean',
      version: 1,
      clientSide: true,
      archived: false,
      variants: [
        { key: 'on', value: true },
        { key: 'off', value: false },
      ],
      environments: {
        development: { enabled: false, offVariant: 'off', fallthrough: { variant: 'off' } },
        production: { enabled: false, offVariant: 'off', rules: [], prerequisites: [] },
      },
    });
    expect(await rulesetVersion()).toBe(before.prod + 1);
    expect(await rulesetVersion('development')).toBe(before.dev + 1);
    const change = await t.db
      .selectFrom('ruleset_changes')
      .selectAll()
      .orderBy('version', 'desc')
      .executeTakeFirstOrThrow();
    expect(change).toMatchObject({ kind: 'flag', key: 'new-checkout' });
    expect(change.value).toMatchObject({ key: 'new-checkout', enabled: false, clientSide: true });
  });

  it('creates typed flags and rejects bad input with field paths', async () => {
    const created = await editor.request('POST', `${P}/flags`, {
      key: 'banner',
      name: 'Banner',
      type: 'string',
      variants: [
        { key: 'a', value: 'Hello' },
        { key: 'b', value: 'Welcome back' },
      ],
    });
    expect(created.json().environments.production.offVariant).toBe('a');

    const wrongType = await editor.request('POST', `${P}/flags`, {
      key: 'limit',
      name: 'Limit',
      type: 'number',
      variants: [
        { key: 'a', value: 'ten' },
        { key: 'b', value: 20 },
      ],
    });
    expect(wrongType.statusCode).toBe(400);
    expect(wrongType.json().error.details).toContainEqual({
      path: 'flags.limit.variants[0].value',
      message: 'must be a number for a number flag',
    });
    const noVariants = await editor.request('POST', `${P}/flags`, {
      key: 'x',
      name: 'X',
      type: 'json',
    });
    expect(noVariants.statusCode).toBe(400);
    const dup = await editor.request('POST', `${P}/flags`, {
      key: 'banner',
      name: 'B',
      type: 'boolean',
    });
    expect(dup.statusCode).toBe(409);
    const badKey = await editor.request('POST', `${P}/flags`, {
      key: '-x',
      name: 'X',
      type: 'boolean',
    });
    expect(badKey.json().error.details[0].path).toBe('key');
  });

  it('lets viewers read but not write', async () => {
    expect((await viewer.request('GET', `${P}/flags/banner`)).statusCode).toBe(200);
    const res = await viewer.request('POST', `${P}/flags`, {
      key: 'v',
      name: 'V',
      type: 'boolean',
    });
    expect(res.statusCode).toBe(403);
    const kill = await viewer.request('POST', `${target('banner')}/kill-switch`, { enabled: true });
    expect(kill.statusCode).toBe(403);
  });

  it('updates targeting with a version and writes one audit entry with a diff', async () => {
    const flag = await create('dark-mode');
    const auditsBefore = await auditCount();
    const res = await editor.request('PUT', target('dark-mode'), {
      version: flag.version,
      enabled: true,
      offVariant: 'off',
      prerequisites: [],
      rules: [
        {
          id: 'staff',
          clauses: [{ attribute: 'email', operator: 'endsWith', values: ['@acme.com'] }],
          serve: { variant: 'on' },
        },
      ],
      fallthrough: {
        rollout: {
          variants: [
            { variant: 'on', weight: 10_000 },
            { variant: 'off', weight: 90_000 },
          ],
        },
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().environments.production.version).toBe(2);
    expect(res.json().environments.development.version).toBe(1);
    expect(res.json().version).toBe(flag.version);
    expect(await auditCount()).toBe(auditsBefore + 1);

    const history = await viewer.request('GET', `${P}/audit?flag=dark-mode`);
    const entry = history.json().entries[0];
    expect(entry).toMatchObject({
      action: 'flag.config.update',
      actor: 'eddie',
      environment: 'production',
      targetKey: 'dark-mode',
    });
    expect(entry.diff).toContainEqual({
      path: 'enabled',
      op: 'changed',
      before: false,
      after: true,
    });
    expect(entry.diff).toContainEqual(expect.objectContaining({ path: 'rules[0]', op: 'added' }));
    expect(entry.diff).toContainEqual(
      expect.objectContaining({ path: 'fallthrough.rollout', op: 'added' }),
    );
    expect(entry.diff).toContainEqual({
      path: 'fallthrough.variant',
      op: 'removed',
      before: 'off',
    });
  });

  it('lets exactly one of two concurrent edits from the same version win', async () => {
    const flag = await create('race');
    const edit = (enabled: boolean) =>
      editor.request('PUT', target('race'), {
        version: flag.environments.production.version,
        enabled,
        offVariant: 'off',
        prerequisites: [],
        rules: [],
        fallthrough: { variant: 'on' },
      });
    const results = await Promise.all([edit(true), edit(false), edit(true)]);
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 409, 409]);
    const conflict = results.find((r) => r.statusCode === 409);
    expect(conflict?.json().error).toMatchObject({
      code: 'version_conflict',
      message:
        'targeting of flag "race" in production was changed by someone else; reload and try again',
      details: { currentVersion: flag.environments.production.version + 1 },
    });
  });

  it('flips the kill switch without a version and bumps the version for editors', async () => {
    const flag = await create('payments-v2');
    const res = await editor.request('POST', `${target('payments-v2')}/kill-switch`, {
      enabled: true,
    });
    expect(res.json()).toMatchObject({
      version: flag.version,
      environments: { production: { enabled: true, version: 2 }, development: { version: 1 } },
    });
    const stale = await editor.request('PUT', target('payments-v2'), {
      version: flag.environments.production.version,
      enabled: false,
      offVariant: 'off',
      prerequisites: [],
      rules: [],
      fallthrough: { variant: 'off' },
    });
    expect(stale.statusCode).toBe(409);
    const history = await viewer.request('GET', `${P}/audit?flag=payments-v2&limit=1`);
    expect(history.json().entries[0].action).toBe('flag.kill_switch');
  });

  it('refuses targeting that references unknown variants or forms a prerequisite cycle', async () => {
    const a = await create('cycle-a');
    const b = await create('cycle-b');
    const config = (prereq: string, extra: Record<string, unknown> = {}) => ({
      enabled: true,
      offVariant: 'off',
      prerequisites: [{ flag: prereq, variant: 'on' }],
      rules: [],
      fallthrough: { variant: 'on' },
      ...extra,
    });
    expect(
      (await editor.request('PUT', target('cycle-a'), { version: a.version, ...config('cycle-b') }))
        .statusCode,
    ).toBe(200);
    const cyclic = await editor.request('PUT', target('cycle-b'), {
      version: b.version,
      ...config('cycle-a'),
    });
    expect(cyclic.statusCode).toBe(400);
    expect(cyclic.json().error.message).toBe(
      'this change would leave the production ruleset invalid',
    );
    expect(cyclic.json().error.details[0].message).toMatch(/prerequisites form a cycle/);

    const unknown = await editor.request('PUT', target('cycle-b'), {
      version: b.version,
      ...config('cycle-a', { prerequisites: [], fallthrough: { variant: 'maybe' } }),
    });
    expect(unknown.json().error.details).toEqual([
      { path: 'flags.cycle-b.fallthrough.variant', message: 'unknown variant "maybe"' },
    ]);
    const missingFlag = await editor.request('PUT', target('nope'), {
      version: 1,
      ...config('cycle-a'),
    });
    expect(missingFlag.statusCode).toBe(404);
    const missingEnv = await editor.request('PUT', target('cycle-b', 'staging'), {
      version: b.version,
      ...config('cycle-a'),
    });
    expect(missingEnv.statusCode).toBe(404);
  });

  it('updates metadata and refuses removing a variant that targeting still uses', async () => {
    const flag = await editor.request('POST', `${P}/flags`, {
      key: 'tier',
      name: 'Tier',
      type: 'string',
      variants: [
        { key: 'gold', value: 'gold' },
        { key: 'silver', value: 'silver' },
        { key: 'bronze', value: 'bronze' },
      ],
    });
    let version = flag.json().version;
    const toBronze = await editor.request('PUT', target('tier'), {
      version,
      enabled: true,
      offVariant: 'gold',
      prerequisites: [],
      rules: [],
      fallthrough: { variant: 'bronze' },
    });
    version = toBronze.json().version;
    const removal = await editor.request('PUT', `${P}/flags/tier`, {
      version,
      variants: [
        { key: 'gold', value: 'gold' },
        { key: 'silver', value: 'silver' },
      ],
    });
    expect(removal.statusCode).toBe(400);
    expect(removal.json().error.details).toContainEqual({
      path: 'flags.tier.fallthrough.variant',
      message: 'unknown variant "bronze"',
    });
    const renamed = await editor.request('PUT', `${P}/flags/tier`, {
      version,
      name: 'Pricing tier',
      clientSide: true,
      description: 'Which tier a customer sees',
    });
    expect(renamed.json()).toMatchObject({
      name: 'Pricing tier',
      clientSide: true,
      version: version + 1,
    });
    const stale = await editor.request('PUT', `${P}/flags/tier`, { version, name: 'x' });
    expect(stale.statusCode).toBe(409);
  });

  it('archives and restores, refusing to archive a flag others depend on', async () => {
    const dep = await create('base');
    const user = await create('dependent');
    await editor.request('PUT', target('dependent'), {
      version: user.version,
      enabled: true,
      offVariant: 'off',
      prerequisites: [{ flag: 'base', variant: 'on' }],
      rules: [],
      fallthrough: { variant: 'on' },
    });
    const blocked = await editor.request('POST', `${P}/flags/base/archive`, {
      version: dep.version,
    });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().error.details[0]).toEqual({
      path: 'flags.dependent.prerequisites[0].flag',
      message: 'unknown flag "base"',
    });

    const lone = await create('retired');
    const archived = await editor.request('POST', `${P}/flags/retired/archive`, {
      version: lone.version,
    });
    expect(archived.json()).toMatchObject({ archived: true, version: lone.version + 1 });
    const change = await t.db
      .selectFrom('ruleset_changes')
      .select(['key', 'value'])
      .orderBy('version', 'desc')
      .executeTakeFirstOrThrow();
    expect(change).toEqual({ key: 'retired', value: null });
    const twice = await editor.request('POST', `${P}/flags/retired/archive`, {
      version: lone.version + 1,
    });
    expect(twice.statusCode).toBe(400);
    const edit = await editor.request('POST', `${target('retired')}/kill-switch`, {
      enabled: true,
    });
    expect(edit.statusCode).toBe(400);
    const listed = await viewer.request('GET', `${P}/flags?environment=production&status=archived`);
    expect(listed.json().flags.map((f: { key: string }) => f.key)).toEqual(['retired']);
    const restored = await editor.request('POST', `${P}/flags/retired/restore`, {
      version: lone.version + 1,
    });
    expect(restored.json().archived).toBe(false);
  });

  it('lists with search, status and type filters, and pages by key', async () => {
    const list = async (query: string) =>
      (await viewer.request('GET', `${P}/flags?environment=production&${query}`))
        .json()
        .flags.map((f: { key: string }) => f.key);
    expect(await list('q=CYCLE')).toEqual(['cycle-a', 'cycle-b']);
    expect(await list('status=rollout')).toEqual(['dark-mode']);
    expect(await list('status=on&q=payments')).toEqual(['payments-v2']);
    expect(await list('type=string')).toEqual(['banner', 'tier']);
    expect(await list('q=%25')).toEqual([]);
    const first = await list('limit=2');
    const next = await list(`limit=2&after=${first[1]}`);
    expect(next[0] > first[1]).toBe(true);
    const off = (await viewer.request('GET', `${P}/flags?environment=production&q=banner`)).json()
      .flags[0];
    expect(off).toMatchObject({ status: 'off', ruleCount: 0, type: 'string' });
    expect((await viewer.request('GET', `${P}/flags`)).statusCode).toBe(400);
    expect((await viewer.request('GET', `${P}/flags?environment=staging`)).statusCode).toBe(404);
    expect(
      (await viewer.request('GET', '/api/projects/ghost/flags?environment=production')).statusCode,
    ).toBe(404);
  });

  it('serves the environment ruleset to the admin UI', async () => {
    const res = await viewer.request('GET', `${P}/environments/production/ruleset`);
    const rs = res.json();
    expect(rs.environment).toBe('production');
    expect(rs.version).toBe(await rulesetVersion());
    expect(Object.keys(rs.flags)).toContain('dark-mode');
    expect(rs.flags.retired).toBeDefined();
  });
});

describe('per-environment versions', () => {
  const targeting = (version: number, enabled: boolean, variant = 'on') => ({
    version,
    enabled,
    offVariant: 'off',
    prerequisites: [],
    rules: [],
    fallthrough: { variant },
  });
  const sdkVersion = async (key: string, env = 'production') =>
    (await viewer.request('GET', `${P}/environments/${env}/ruleset`)).json().flags[key]?.version;

  it('never conflicts across environments, even when both edits start from one load', async () => {
    const flag = await create('split');
    const [prod, dev] = await Promise.all([
      editor.request('PUT', target('split'), targeting(flag.environments.production.version, true)),
      editor.request(
        'PUT',
        target('split', 'development'),
        targeting(flag.environments.development.version, true, 'off'),
      ),
    ]);
    expect([prod.statusCode, dev.statusCode], `${prod.body} ${dev.body}`).toEqual([200, 200]);
    const after = (await viewer.request('GET', `${P}/flags/split`)).json();
    expect(after).toMatchObject({
      version: 1,
      environments: {
        production: { version: 2, enabled: true, fallthrough: { variant: 'on' } },
        development: { version: 2, enabled: true, fallthrough: { variant: 'off' } },
      },
    });

    // A second edit to production from the first load still conflicts, and
    // the conflict reports production's targeting version.
    const stale = await editor.request(
      'PUT',
      target('split'),
      targeting(flag.environments.production.version, false),
    );
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.details).toEqual({ currentVersion: 2 });
  });

  it('keeps metadata and targeting preconditions apart', async () => {
    const flag = await create('apart');
    const renamed = await editor.request('PUT', `${P}/flags/apart`, {
      version: flag.version,
      name: 'Apart',
    });
    expect(renamed.json()).toMatchObject({
      version: 2,
      environments: { production: { version: 1 } },
    });
    // Targeting loaded before the rename saves cleanly...
    const saved = await editor.request(
      'PUT',
      target('apart'),
      targeting(flag.environments.production.version, true),
    );
    expect(saved.statusCode, saved.body).toBe(200);
    // ...and settings loaded before the targeting edit do too.
    const described = await editor.request('PUT', `${P}/flags/apart`, {
      version: 2,
      description: 'Kept apart',
    });
    expect(described.statusCode, described.body).toBe(200);
    expect(described.json()).toMatchObject({
      version: 3,
      name: 'Apart',
      description: 'Kept apart',
      environments: { production: { version: 2, enabled: true } },
    });
    // A stale metadata version is still refused with the metadata version.
    const stale = await editor.request('PUT', `${P}/flags/apart`, { version: 2, name: 'x' });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.details).toEqual({ currentVersion: 3 });
    // Archive and restore are metadata changes.
    expect(
      (await editor.request('POST', `${P}/flags/apart/archive`, { version: 2 })).statusCode,
    ).toBe(409);
    const archived = await editor.request('POST', `${P}/flags/apart/archive`, { version: 3 });
    expect(archived.json()).toMatchObject({
      version: 4,
      environments: { production: { version: 2 } },
    });
    await editor.request('POST', `${P}/flags/apart/restore`, { version: 4 });
  });

  it('runs a metadata edit and edits in two environments at once without losing any', async () => {
    const flag = await create('trio');
    const results = await Promise.all([
      editor.request('PUT', `${P}/flags/trio`, { version: flag.version, name: 'Trio' }),
      editor.request('PUT', target('trio'), targeting(1, true)),
      editor.request('PUT', target('trio', 'development'), targeting(1, true)),
    ]);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    const after = (await viewer.request('GET', `${P}/flags/trio`)).json();
    expect(after).toMatchObject({
      name: 'Trio',
      version: 2,
      environments: { production: { version: 2, enabled: true }, development: { version: 2 } },
    });
  });

  it('gives SDKs a flag version that goes up by one with every change they see', async () => {
    const flag = await create('counted');
    expect(await sdkVersion('counted')).toBe(1);
    expect(await sdkVersion('counted', 'development')).toBe(1);

    await editor.request('PUT', target('counted'), targeting(1, true));
    expect(await sdkVersion('counted')).toBe(2);
    expect(await sdkVersion('counted', 'development')).toBe(1);

    await editor.request('POST', `${target('counted')}/kill-switch`, { enabled: false });
    expect(await sdkVersion('counted')).toBe(3);

    await editor.request('PUT', `${P}/flags/counted`, { version: flag.version, name: 'Counted' });
    expect(await sdkVersion('counted')).toBe(4);
    expect(await sdkVersion('counted', 'development')).toBe(2);

    // The streamed change carries the same version as the snapshot.
    const change = await t.db
      .selectFrom('ruleset_changes')
      .innerJoin('environments', 'environments.id', 'ruleset_changes.environment_id')
      .select('ruleset_changes.value')
      .where('environments.key', '=', 'production')
      .where('ruleset_changes.key', '=', 'counted')
      .orderBy('ruleset_changes.version', 'desc')
      .executeTakeFirstOrThrow();
    expect(change.value).toMatchObject({ version: 4 });
  });

  it('lists the targeting version and the latest change for the environment', async () => {
    const list = async (env: string) =>
      (await viewer.request('GET', `${P}/flags?environment=${env}&q=counted`)).json().flags[0];
    const prod = await list('production');
    const dev = await list('development');
    expect(prod).toMatchObject({ version: 2, targetingVersion: 3 });
    expect(dev).toMatchObject({ version: 2, targetingVersion: 1 });
    const flag = (await viewer.request('GET', `${P}/flags/counted`)).json();
    expect(flag.updatedAt >= flag.environments.production.updatedAt).toBe(true);
    expect(prod.updatedAt >= flag.environments.production.updatedAt).toBe(true);

    await editor.request('PUT', target('counted', 'development'), targeting(1, true));
    const later = (await viewer.request('GET', `${P}/flags/counted`)).json();
    expect((await list('development')).updatedAt).toBe(later.environments.development.updatedAt);
    expect(later.updatedAt).toBe(later.environments.development.updatedAt);
  });
});

describe('segments', () => {
  const S = `${P}/environments/production/segments`;
  const body = {
    key: 'beta',
    name: 'Beta testers',
    included: ['alice'],
    excluded: [],
    rules: [
      {
        id: 'staff',
        clauses: [{ attribute: 'email', operator: 'endsWith', values: ['@acme.com'] }],
      },
    ],
  };

  it('creates, updates with a version and audits', async () => {
    const created = await editor.request('POST', S, body);
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({ key: 'beta', version: 1, included: ['alice'] });
    expect((await editor.request('POST', S, body)).statusCode).toBe(409);
    const { key, ...rest } = body;
    expect(key).toBe('beta');
    const updated = await editor.request('PUT', `${S}/beta`, {
      ...rest,
      version: 1,
      included: ['alice', 'bob'],
    });
    expect(updated.json()).toMatchObject({ version: 2, included: ['alice', 'bob'] });
    expect((await editor.request('PUT', `${S}/beta`, { ...rest, version: 1 })).statusCode).toBe(
      409,
    );
    expect((await viewer.request('GET', `${S}/beta`)).json().version).toBe(2);
    expect((await viewer.request('GET', S)).json().segments).toHaveLength(1);
    expect((await viewer.request('GET', `${S}/ghost`)).statusCode).toBe(404);
    const history = await viewer.request('GET', `${P}/audit?segment=beta`);
    expect(history.json().entries[0].diff).toEqual([
      { path: 'included[1]', op: 'added', after: 'bob' },
    ]);
    const bad = await editor.request('POST', S, {
      ...body,
      key: 'bad',
      rules: [
        { id: 'r', clauses: [{ attribute: 'email', operator: 'matches', values: ['(a+)\\1'] }] },
      ],
    });
    expect(bad.statusCode).toBe(400);
  });

  it('refuses to delete a segment a flag uses, and deletes it once unused', async () => {
    const flag = await create('segmented');
    await editor.request('PUT', target('segmented'), {
      version: flag.version,
      enabled: true,
      offVariant: 'off',
      prerequisites: [],
      rules: [
        {
          id: 'beta',
          clauses: [{ operator: 'inSegment', segments: ['beta'] }],
          serve: { variant: 'on' },
        },
      ],
      fallthrough: { variant: 'off' },
    });
    const blocked = await editor.request('DELETE', `${S}/beta?version=2`);
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().error.details[0].message).toBe('unknown segment "beta"');
    // Targeting edits leave the metadata version alone, so archive takes the original one.
    const archived = await editor.request('POST', `${P}/flags/segmented/archive`, {
      version: flag.version,
    });
    expect(archived.statusCode, archived.body).toBe(200);
    expect((await editor.request('DELETE', `${S}/beta?version=1`)).statusCode).toBe(409);
    expect((await editor.request('DELETE', `${S}/beta?version=2`)).statusCode).toBe(204);
    expect((await editor.request('DELETE', `${S}/beta?version=2`)).statusCode).toBe(404);
  });
});

describe('audit', () => {
  it('pages through the whole project history', async () => {
    const first = (await viewer.request('GET', `${P}/audit?limit=5`)).json();
    expect(first.entries).toHaveLength(5);
    expect(first.next).toBe(first.entries[4].id);
    const second = (await viewer.request('GET', `${P}/audit?limit=5&before=${first.next}`)).json();
    expect(second.entries[0].id).toBeLessThan(first.next);
    const all = (await viewer.request('GET', `${P}/audit?limit=200`)).json();
    expect(all.next).toBeNull();
    for (const e of all.entries) {
      expect(e.actor).not.toBe('');
      expect(typeof e.at).toBe('string');
    }
  });
});
