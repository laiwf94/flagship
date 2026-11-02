import { rulesetChecksum, type Ruleset } from '@flagship/core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApp, type TestApp } from '../../test/app.js';
import { PASSWORD, signIn, userWithRole, type Client } from '../../test/session.js';
import { getEnvironment, getProject } from './projects.js';
import { loadRuleset } from './rulesets.js';
import {
  EXPORT_FORMAT,
  exportProject,
  planImport,
  type ExportDocument,
  type ImportSummary,
} from './transfer.js';

let t: TestApp;
let admin: Client;
let editor: Client;

const S = '/api/projects/shop';

async function ok(
  method: Parameters<Client['request']>[0],
  url: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const res = await admin.request(method, url, body);
  expect(res.statusCode, `${method} ${url}: ${res.body}`).toBeLessThan(300);
  return res.body === '' ? {} : res.json<Record<string, unknown>>();
}

async function exported(project: string): Promise<ExportDocument & Record<string, unknown>> {
  const res = await admin.request('GET', `/api/projects/${project}/export`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

async function importDoc(body: unknown, query = '') {
  return admin.request('POST', `/api/projects/import${query}`, body);
}

async function ruleset(project: string, env: string): Promise<Ruleset> {
  const p = await getProject(t.db, project);
  return loadRuleset(t.db, (await getEnvironment(t.db, p.id, env)).id);
}

async function projectCount(): Promise<number> {
  const r = await t.db
    .selectFrom('projects')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .executeTakeFirstOrThrow();
  return Number(r.n);
}

/** A copy of a document that can be changed freely. */
const copy = <T>(v: T): T => structuredClone(v);

beforeAll(async () => {
  t = await testApp({ bootstrapAdmin: { email: 'root@example.com', password: PASSWORD } });
  admin = await signIn(t.app.server, 'root@example.com');
  editor = await userWithRole(t.app.server, t.db, 'eddie@example.com', 'editor');

  // A project that uses every kind of thing an export has to carry.
  await ok('POST', '/api/projects', {
    key: 'shop',
    name: 'Shöp ✓',
    environments: [
      { key: 'staging', name: 'Staging' },
      { key: 'production', name: 'Production' },
    ],
  });
  await ok('POST', `${S}/environments/production/segments`, {
    key: 'beta',
    name: 'Beta testers',
    description: 'People who asked for early access',
    included: ['user-1', 'user-2', 'ünïcode-3'],
    excluded: ['user-9'],
    rules: [
      { id: 'r1', clauses: [{ attribute: 'email', operator: 'endsWith', values: ['@x.io'] }] },
    ],
  });
  await ok('POST', `${S}/environments/staging/segments`, {
    key: 'staff',
    name: 'Staff',
    included: ['ann'],
    excluded: [],
    rules: [],
  });
  await ok('POST', `${S}/flags`, {
    key: 'checkout',
    name: 'New checkout',
    description: 'One-page checkout',
    type: 'boolean',
    clientSide: true,
  });
  await ok('PUT', `${S}/flags/checkout/environments/production`, {
    version: 1,
    enabled: true,
    offVariant: 'off',
    prerequisites: [],
    rules: [
      {
        id: 'beta',
        description: 'beta gets it',
        clauses: [{ operator: 'inSegment', segments: ['beta'] }],
        serve: { variant: 'on' },
      },
      {
        id: 'apps',
        clauses: [
          { attribute: 'appVersion', operator: 'semverGt', values: ['2.1.0'] },
          { attribute: 'country', operator: 'in', values: ['de', 'fr'], negate: true },
        ],
        serve: {
          rollout: {
            bucketBy: 'org',
            variants: [
              { variant: 'on', weight: 30_000 },
              { variant: 'off', weight: 70_000 },
            ],
          },
        },
      },
    ],
    fallthrough: {
      rollout: {
        variants: [
          { variant: 'on', weight: 25_000 },
          { variant: 'off', weight: 75_000 },
        ],
      },
    },
  });
  await ok('POST', `${S}/flags/checkout/environments/staging/kill-switch`, { enabled: true });
  await ok('POST', `${S}/flags/checkout/environments/staging/kill-switch`, { enabled: false });
  await ok('POST', `${S}/flags`, {
    key: 'banner',
    name: 'Banner',
    type: 'string',
    variants: [
      { key: 'blue', value: 'blue', name: 'Blue' },
      { key: 'red', value: 'red' },
    ],
  });
  await ok('PUT', `${S}/flags/banner/environments/production`, {
    version: 1,
    enabled: true,
    offVariant: 'blue',
    prerequisites: [{ flag: 'checkout', variant: 'on' }],
    rules: [],
    fallthrough: { variant: 'red' },
  });
  await ok('PUT', `${S}/flags/banner`, { version: 1, name: 'Banner colour' });
  await ok('POST', `${S}/flags`, {
    key: 'limits',
    name: 'Limits',
    type: 'json',
    variants: [
      { key: 'small', value: { items: 10, tags: ['a', 'b'], nested: { é: null } } },
      { key: 'large', value: { items: 1000 } },
    ],
  });
  await ok('POST', `${S}/flags`, { key: 'retired', name: 'Retired', type: 'boolean' });
  await ok('POST', `${S}/flags/retired/archive`, { version: 1 });
});
afterAll(() => t.close());

describe('export', () => {
  it('streams a versioned document with the checksums SDKs see', async () => {
    const res = await admin.request('GET', `${S}/export`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="shop-\d{4}-\d{2}-\d{2}\.flagship\.json"$/,
    );
    // Streamed: the length isn't known up front.
    expect(res.headers['content-length']).toBeUndefined();
    const doc = res.json<ExportDocument>();
    expect(doc).toMatchObject({
      format: EXPORT_FORMAT,
      formatVersion: 1,
      project: { key: 'shop', name: 'Shöp ✓' },
      // Created in one transaction, so listed by key, as everywhere else.
      environments: [
        { key: 'production', name: 'Production' },
        { key: 'staging', name: 'Staging' },
      ],
    });
    expect(doc.flags.map((f) => f.key)).toEqual(['banner', 'checkout', 'limits', 'retired']);
    expect(doc.flags.find((f) => f.key === 'retired')?.archived).toBe(true);
    expect(doc.flags.find((f) => f.key === 'banner')).toMatchObject({
      name: 'Banner colour',
      salt: 'banner',
      version: 2,
      environments: { production: { version: 2, enabled: true }, staging: { version: 1 } },
    });
    expect(doc.flags.find((f) => f.key === 'checkout')?.environments['staging']?.version).toBe(3);
    expect(doc.segments.map((s) => `${s.environment}/${s.key}`)).toEqual([
      'production/beta',
      'staging/staff',
    ]);
    for (const env of ['staging', 'production']) {
      const rs = await ruleset('shop', env);
      expect(doc.checksums?.[env]).toBe(rulesetChecksum(rs));
    }
    // One line per flag and segment, so diffs show what changed; every value survives a parse.
    const lines = res.body.split('\n');
    expect(lines.filter((l) => l.startsWith('    {"key":'))).toHaveLength(doc.flags.length);
    expect(lines.filter((l) => l.startsWith('    {"environment":'))).toHaveLength(2);
    expect(JSON.parse(res.body)).toEqual(doc);
  });

  it('exports an empty project as valid JSON', async () => {
    const doc = await exported('default');
    expect(doc.flags).toEqual([]);
    expect(doc.segments).toEqual([]);
    expect(doc.checksums).toEqual({ development: '0'.repeat(64), production: '0'.repeat(64) });
  });

  it('is for admins, and an unknown project is a plain 404', async () => {
    expect((await editor.request('GET', `${S}/export`)).statusCode).toBe(403);
    const missing = await admin.request('GET', '/api/projects/ghost/export');
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('not_found');
  });

  it('reads one snapshot, so writes made while it streams do not show up', async () => {
    const before = await ruleset('shop', 'production');
    const chunks = exportProject(t.db, 'shop');
    const parts: string[] = [];
    const first = await chunks.next();
    if (first.done !== true) parts.push(first.value);
    await ok('POST', `${S}/flags/checkout/environments/production/kill-switch`, { enabled: false });
    await ok('POST', `${S}/flags`, { key: 'late', name: 'Late', type: 'boolean' });
    for await (const part of chunks) parts.push(part);
    const doc = JSON.parse(parts.join('')) as ExportDocument;
    expect(doc.flags.map((f) => f.key)).not.toContain('late');
    expect(doc.flags.find((f) => f.key === 'checkout')?.environments['production']?.enabled).toBe(
      true,
    );
    expect(doc.checksums?.['production']).toBe(rulesetChecksum(before));
    // Put things back for the other tests.
    await ok('POST', `${S}/flags/checkout/environments/production/kill-switch`, { enabled: true });
    await ok('POST', `${S}/flags/late/archive`, { version: 1 });
  });

  it('rolls its transaction back when the reader goes away', async () => {
    const open = async () => {
      const r = await sql<{ n: string }>`
        SELECT count(*) AS n FROM pg_stat_activity
        WHERE datname = current_database() AND state LIKE 'idle in transaction%'`.execute(t.db);
      return Number(r.rows[0]?.n);
    };
    const chunks = exportProject(t.db, 'shop');
    await chunks.next();
    expect(await open()).toBe(1);
    await chunks.return(undefined);
    expect(await open()).toBe(0);
  });

  it('pages through large projects and stays consistent across pages', async () => {
    // 400 flags is exactly two full pages; 45 segments in one environment is not a multiple.
    const flags = Array.from({ length: 400 }, (_, i) => ({
      key: `f-${String(i).padStart(3, '0')}`,
      name: `Flag ${i}`,
      type: 'boolean',
      variants: [
        { key: 'on', value: true },
        { key: 'off', value: false },
      ],
      environments: {
        main: {
          enabled: i % 2 === 0,
          offVariant: 'off',
          prerequisites: [],
          rules: [
            {
              id: 'seg',
              clauses: [
                { operator: 'inSegment', segments: [`s-${String(i % 45).padStart(2, '0')}`] },
              ],
              serve: { variant: 'on' },
            },
          ],
          fallthrough: { variant: 'off' },
        },
      },
    }));
    const segments = Array.from({ length: 45 }, (_, i) => ({
      environment: 'main',
      key: `s-${String(i).padStart(2, '0')}`,
      name: `Segment ${i}`,
      included: [`user-${i}`],
      excluded: [],
      rules: [],
    }));
    const res = await importDoc({
      format: EXPORT_FORMAT,
      formatVersion: 1,
      project: { key: 'big', name: 'Big' },
      environments: [{ key: 'main', name: 'Main' }],
      flags,
      segments,
    });
    expect(res.statusCode, res.body).toBe(201);
    const parts: string[] = [];
    for await (const part of exportProject(t.db, 'big')) parts.push(part);
    expect(parts.length).toBeGreaterThan(5);
    const doc = JSON.parse(parts.join('')) as ExportDocument;
    expect(doc.flags.map((f) => f.key)).toEqual(flags.map((f) => f.key));
    expect(doc.segments.map((s) => s.key)).toEqual(segments.map((s) => s.key));
    expect(doc.checksums?.['main']).toBe(rulesetChecksum(await ruleset('big', 'main')));
    expect(doc.checksums?.['main']).toBe(res.json<ImportSummary>().checksums['main']);
  });
});

describe('import', () => {
  it('round-trips a whole project: same rulesets, same checksums, same document', async () => {
    const original = await exported('shop');
    const auditBefore = await t.db
      .selectFrom('audit_log')
      .select('id')
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    const res = await importDoc(original, '?key=shop-copy&name=Shop%20copy');
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toEqual({
      project: { key: 'shop-copy', name: 'Shop copy' },
      environments: ['production', 'staging'],
      flags: original.flags.length,
      segments: 2,
      checksums: original.checksums,
    });
    for (const env of ['staging', 'production']) {
      const [a, b] = [await ruleset('shop', env), await ruleset('shop-copy', env)];
      expect(b.flags).toEqual(a.flags);
      expect(b.segments).toEqual(a.segments);
    }
    const again = await exported('shop-copy');
    const strip = ({ exportedAt: _a, project: _p, ...rest }: ExportDocument) => rest;
    expect(strip(again)).toEqual(strip(original));
    expect(again.project).toEqual({ key: 'shop-copy', name: 'Shop copy' });

    const audit = await t.db
      .selectFrom('audit_log')
      .selectAll()
      .where('id', '>', auditBefore.id)
      .execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'project.import',
      target_key: 'shop-copy',
      actor_id: admin.userId,
      actor_name: 'Admin',
      after: {
        flags: original.flags.length,
        segments: 2,
        from: { key: 'shop', name: 'Shöp ✓' },
      },
    });
  });

  it('gives an imported project that SDKs and editors can use straight away', async () => {
    const original = await exported('shop');
    expect((await importDoc(original, '?key=shop-live')).statusCode).toBe(201);
    const key = await ok('POST', '/api/projects/shop-live/environments/production/api-keys', {
      kind: 'server',
      name: 'sdk',
    });
    const snap = await t.app.server.inject({
      url: '/sdk/v1/ruleset',
      headers: { authorization: `Bearer ${String(key['secret'])}` },
    });
    expect(snap.statusCode).toBe(200);
    expect(snap.json().checksum).toBe(original.checksums?.['production']);
    // Versions are kept, so an editor's next save uses the exported ones.
    const banner = original.flags.find((f) => f.key === 'banner');
    await ok('PUT', '/api/projects/shop-live/flags/banner', {
      version: banner?.version,
      name: 'Renamed',
    });
    await ok('POST', '/api/projects/shop-live/flags/retired/restore', { version: 2 });
    expect((await ruleset('shop-live', 'production')).flags['retired']).toBeDefined();
  });

  it('accepts files larger than the usual 1 MB body limit', async () => {
    const big = Array.from({ length: 10_000 }, (_, i) => `member-${'x'.repeat(100)}-${i}`);
    const doc = {
      format: EXPORT_FORMAT,
      formatVersion: 1,
      project: { key: 'members', name: 'Members' },
      environments: [{ key: 'main', name: 'Main' }],
      flags: [],
      segments: [
        { environment: 'main', key: 'a', name: 'A', included: big, excluded: [], rules: [] },
        { environment: 'main', key: 'b', name: 'B', included: [], excluded: big, rules: [] },
      ],
    };
    expect(JSON.stringify(doc).length).toBeGreaterThan(2 * 1024 * 1024);
    const res = await importDoc(doc);
    expect(res.statusCode, res.body).toBe(201);
    expect((await ruleset('members', 'main')).segments['b']?.excluded).toHaveLength(10_000);
  });

  it('refuses an existing project key and writes nothing', async () => {
    const original = await exported('shop');
    const before = await projectCount();
    const res = await importDoc(original);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('already_exists');
    expect(await projectCount()).toBe(before);
  });

  it('rolls everything back when a write fails part way', async () => {
    await sql`
      CREATE FUNCTION boom() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'boom'; END $$`.execute(t.db);
    await sql`
      CREATE TRIGGER boom BEFORE INSERT ON segments FOR EACH ROW
      WHEN (NEW.key = 'staff') EXECUTE FUNCTION boom()`.execute(t.db);
    try {
      const before = await projectCount();
      const res = await importDoc(await exported('shop'), '?key=half');
      expect(res.statusCode).toBe(500);
      expect(await projectCount()).toBe(before);
      const flags = await t.db
        .selectFrom('flags')
        .innerJoin('projects', 'projects.id', 'flags.project_id')
        .select('flags.key')
        .where('projects.key', '=', 'half')
        .execute();
      expect(flags).toEqual([]);
    } finally {
      await sql`DROP TRIGGER boom ON segments`.execute(t.db);
      await sql`DROP FUNCTION boom()`.execute(t.db);
    }
  });

  it('is for admins only and checks its query', async () => {
    const original = await exported('shop');
    const denied = await editor.request('POST', '/api/projects/import?key=nope', original);
    expect(denied.statusCode).toBe(403);
    expect((await importDoc(original, '?key=has%20space')).statusCode).toBe(400);
    expect((await importDoc(original, '?other=1')).statusCode).toBe(400);
  });

  it('rejects a truncated download', async () => {
    const res = await admin.request('GET', `${S}/export`);
    const cut = res.body.slice(0, Math.floor(res.body.length * 0.8));
    const sent = await admin.request('POST', '/api/projects/import?key=cut', cut, {
      headers: { 'content-type': 'application/json' },
    });
    expect(sent.statusCode).toBe(400);
    expect(sent.json().error.message).toBe('request body is not valid JSON');
  });

  it('enforces its own body limit', async () => {
    const small = await testApp({
      bootstrapAdmin: { email: 'root@example.com', password: PASSWORD },
      importMaxBytes: 4096,
    });
    try {
      const root = await signIn(small.app.server, 'root@example.com');
      const exportRes = await root.request('GET', '/api/projects/default/export');
      const doc = exportRes.json<ExportDocument>();
      const fits = await root.request('POST', '/api/projects/import?key=fits', doc);
      expect(fits.statusCode, fits.body).toBe(201);
      const body = JSON.stringify(doc) + ' '.repeat(5000);
      const tooBig = await root.request('POST', '/api/projects/import?key=big', body, {
        headers: { 'content-type': 'application/json' },
      });
      expect(tooBig.statusCode).toBe(413);
    } finally {
      await small.close();
    }
  });
});

describe('import validation', () => {
  let base: ExportDocument;
  beforeAll(async () => {
    base = await exported('shop');
  });

  /** Plans a changed copy of the shop export and returns the problems it reports. */
  function problems(change: (doc: ExportDocument) => unknown): { path: string; message: string }[] {
    const doc = copy(base);
    const changed = change(doc) ?? doc;
    try {
      planImport(changed);
    } catch (err) {
      const e = err as { code?: string; message: string; details?: unknown };
      expect(e.code).toBe('invalid_argument');
      expect(e.message).toBe('invalid project export');
      return e.details as { path: string; message: string }[];
    }
    throw new Error('expected the document to be refused');
  }

  const at = (key: string) => base.flags.findIndex((f) => f.key === key);
  const flag = (doc: ExportDocument, key: string) => {
    const f = doc.flags.find((x) => x.key === key);
    if (f === undefined) throw new Error(`no flag ${key}`);
    return f;
  };
  const target = (doc: ExportDocument, key: string, env: string) => {
    const e = flag(doc, key).environments[env];
    if (e === undefined) throw new Error(`no ${env} targeting for ${key}`);
    return e;
  };

  it('accepts the export itself', () => {
    const plan = planImport(copy(base));
    expect(plan.checksums).toEqual(base.checksums);
    expect([...plan.rulesets.keys()]).toEqual(['production', 'staging']);
  });

  it('names what it reads when the header is wrong', () => {
    expect(problems(() => [])).toEqual([{ path: '', message: 'must be a JSON object' }]);
    expect(problems(() => 'text')).toEqual([{ path: '', message: 'must be a JSON object' }]);
    expect(problems((d) => ({ ...d, format: 'other' }))).toEqual([
      { path: 'format', message: 'must be "flagship.project"' },
    ]);
    expect(problems((d) => ({ ...d, formatVersion: 2 }))).toEqual([
      {
        path: 'formatVersion',
        message: 'version 2 is not supported; this server reads version 1',
      },
    ]);
    expect(problems((d) => ({ ...d, formatVersion: undefined }))[0]?.message).toBe(
      'version missing is not supported; this server reads version 1',
    );
  });

  it('checks shape and limits with paths into the document', () => {
    expect(problems((d) => ({ ...d, extra: true }))[0]?.message).toMatch(/unrecognized key/i);
    expect(
      problems((d) => {
        flag(d, 'banner').key = 'has space';
      })[0]?.path,
    ).toBe(`flags.${at('banner')}.key`);
    expect(
      problems((d) => {
        d.environments = [];
      })[0]?.path,
    ).toBe('environments');
    expect(
      problems((d) => {
        target(d, 'banner', 'production').version = 0;
      })[0]?.path,
    ).toBe(`flags.${at('banner')}.environments.production.version`);
  });

  it('refuses duplicates and unknown or missing environments', () => {
    expect(
      problems((d) => {
        d.environments.push({ key: 'staging', name: 'Again' });
      }),
    ).toContainEqual({ path: 'environments.2.key', message: 'duplicate' });
    expect(
      problems((d) => {
        d.flags.push(copy(flag(d, 'banner')));
      }),
    ).toEqual([{ path: `flags.${base.flags.length}.key`, message: 'duplicate' }]);
    expect(
      problems((d) => {
        const s = d.segments[0];
        if (s !== undefined) d.segments.push(copy(s));
      }),
    ).toEqual([{ path: 'segments.2.key', message: 'duplicate in production' }]);
    expect(
      problems((d) => {
        Reflect.deleteProperty(flag(d, 'limits').environments, 'staging');
      }),
    ).toEqual([
      {
        path: `flags.${at('limits')}.environments`,
        message: 'has no targeting for environment "staging"',
      },
    ]);
    expect(
      problems((d) => {
        flag(d, 'limits').environments['qa'] = copy(target(d, 'limits', 'staging'));
      }),
    ).toEqual([
      {
        path: `flags.${at('limits')}.environments.qa`,
        message: 'is not one of the exported environments',
      },
    ]);
    expect(
      problems((d) => {
        const s = d.segments[0];
        if (s !== undefined) s.environment = 'qa';
      }),
    ).toEqual([
      { path: 'segments.0.environment', message: 'is not one of the exported environments' },
    ]);
    // Keys that exist on every object are not mistaken for environments.
    expect(
      problems((d) => {
        d.environments.push({ key: 'constructor', name: 'C' });
        delete d.checksums;
      }).map((p) => p.message),
    ).toContain('has no targeting for environment "constructor"');
  });

  it('validates each environment as a ruleset, the way an edit would be', () => {
    expect(
      problems((d) => {
        target(d, 'banner', 'production').offVariant = 'green';
        delete d.checksums;
      }),
    ).toEqual([
      {
        path: 'rulesets.production.flags.banner.offVariant',
        message: expect.stringContaining('green'),
      },
    ]);
    const dangling = problems((d) => {
      d.segments = d.segments.filter((s) => s.key !== 'beta');
      delete d.checksums;
    });
    expect(dangling[0]?.path).toMatch(/^rulesets\.production\.flags\.checkout\.rules/);
    expect(dangling[0]?.message).toContain('beta');
    const cycle = problems((d) => {
      target(d, 'checkout', 'production').prerequisites = [{ flag: 'banner', variant: 'red' }];
      delete d.checksums;
    });
    expect(cycle.map((p) => p.message).join(' ')).toMatch(/cycle/);
    // An archived flag must still be one that could be restored.
    expect(
      problems((d) => {
        target(d, 'retired', 'staging').fallthrough = { variant: 'maybe' };
        delete d.checksums;
      }),
    ).toEqual([
      {
        path: `flags.${at('retired')}.environments.staging`,
        message: expect.stringMatching(/^fallthrough.*maybe/),
      },
    ]);
  });

  it('refuses a file edited after export unless the checksums are removed', () => {
    const edit = (d: ExportDocument) => {
      target(d, 'checkout', 'production').enabled = false;
    };
    expect(problems(edit)).toEqual([
      { path: 'checksums.production', message: expect.stringContaining('changed after it was') },
    ]);
    const edited = copy(base);
    edit(edited);
    delete edited.checksums;
    expect(planImport(edited).checksums['production']).not.toBe(base.checksums?.['production']);
    // Archived flags aren't served, so they are not part of any checksum.
    const archived = copy(base);
    target(archived, 'retired', 'production').enabled = true;
    expect(planImport(archived).checksums).toEqual(base.checksums);
    expect(
      problems((d) => {
        Reflect.deleteProperty(d.checksums ?? {}, 'staging');
      }),
    ).toEqual([{ path: 'checksums.staging', message: 'missing' }]);
    expect(
      problems((d) => {
        (d.checksums ?? {})['qa'] = '0'.repeat(64);
      }),
    ).toEqual([{ path: 'checksums.qa', message: 'is not one of the exported environments' }]);
  });

  it('fills in defaults for hand-written files', () => {
    const plan = planImport({
      format: EXPORT_FORMAT,
      formatVersion: 1,
      project: { key: 'hand', name: 'Hand written' },
      environments: [{ key: 'prod', name: 'Prod' }],
      flags: [
        {
          key: 'simple',
          name: 'Simple',
          type: 'boolean',
          variants: [
            { key: 'on', value: true },
            { key: 'off', value: false },
          ],
          environments: {
            prod: {
              enabled: true,
              offVariant: 'off',
              prerequisites: [],
              rules: [],
              fallthrough: { variant: 'on' },
            },
          },
        },
      ],
      segments: [],
    });
    expect(plan.rulesets.get('prod')?.flags['simple']).toMatchObject({
      salt: 'simple',
      clientSide: false,
      version: 1,
    });
    expect(plan.document.flags[0]).toMatchObject({ description: '', archived: false });
  });
});
