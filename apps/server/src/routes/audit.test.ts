import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApp, type TestApp } from '../../test/app.js';
import { PASSWORD, signIn, userWithRole, type Client } from '../../test/session.js';
import { decodeCursor, encodeCursor, searchQuery } from '../services/audit.js';

let t: TestApp;
let admin: Client;
let editor: Client;
let other: Client;
let viewer: Client;

const P = '/api/projects/default';
const target = (flag: string, env = 'production') => `${P}/flags/${flag}/environments/${env}`;
const SEG = (env = 'production') => `${P}/environments/${env}/segments`;

const note = (reason?: string, link?: string) => ({
  headers: {
    ...(reason === undefined ? {} : { 'flagship-reason': encodeURIComponent(reason) }),
    ...(link === undefined ? {} : { 'flagship-link': link }),
  },
});

interface Entry {
  id: number;
  at: string;
  actor: string;
  action: string;
  targetKey: string;
  environment: string | null;
  reason: string | null;
  link: string | null;
}

async function audit(query: string): Promise<{ entries: Entry[]; next: string | null }> {
  const res = await viewer.request('GET', `${P}/audit?${query}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

async function flag(key: string) {
  const res = await editor.request('POST', `${P}/flags`, { key, name: key, type: 'boolean' });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

async function policy(env: string, requireReason: boolean, requireLink: boolean) {
  const res = await admin.request('PUT', `${P}/environments/${env}/change-notes`, {
    requireReason,
    requireLink,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

beforeAll(async () => {
  t = await testApp({ bootstrapAdmin: { email: 'root@example.com', password: PASSWORD } });
  admin = await signIn(t.app.server, 'root@example.com');
  editor = await userWithRole(t.app.server, t.db, 'eddie@example.com', 'editor');
  other = await userWithRole(t.app.server, t.db, 'olga@example.com', 'editor');
  viewer = await userWithRole(t.app.server, t.db, 'vera@example.com', 'viewer');
});
afterAll(() => t.close());

describe('reasons and links', () => {
  it('records the reason and link given with a change on its audit entry', async () => {
    await flag('checkout');
    const reason = 'Checkout errors after deploy – rolling back ✓';
    const res = await editor.request(
      'POST',
      `${target('checkout')}/kill-switch`,
      { enabled: true },
      note(reason, 'https://tickets.example.com/INC-7'),
    );
    expect(res.statusCode, res.body).toBe(200);
    const [entry] = (await audit('flag=checkout&limit=1')).entries;
    expect(entry).toMatchObject({
      action: 'flag.kill_switch',
      actor: 'eddie',
      reason,
      link: 'https://tickets.example.com/INC-7',
    });
    // Without headers nothing is recorded.
    await editor.request('POST', `${target('checkout')}/kill-switch`, { enabled: false });
    const [plain] = (await audit('flag=checkout&limit=1')).entries;
    expect(plain).toMatchObject({ reason: null, link: null });
  });

  it('refuses malformed reasons and links before changing anything', async () => {
    await flag('malformed');
    const cases: [Record<string, string>, string][] = [
      [{ 'flagship-reason': '%E0%A4%A' }, 'header.flagship-reason'],
      [{ 'flagship-reason': '%20%20' }, 'header.flagship-reason'],
      [{ 'flagship-reason': 'x'.repeat(1001) }, 'header.flagship-reason'],
      [{ 'flagship-link': 'ftp://tickets.example.com/1' }, 'header.flagship-link'],
      [{ 'flagship-link': 'not a url' }, 'header.flagship-link'],
      [{ 'flagship-link': `https://e.com/${'a'.repeat(2000)}` }, 'header.flagship-link'],
    ];
    for (const [headers, path] of cases) {
      const res = await editor.request(
        'POST',
        `${target('malformed')}/kill-switch`,
        { enabled: true },
        { headers },
      );
      expect(res.statusCode, JSON.stringify(headers).slice(0, 80)).toBe(400);
      expect(res.json().error.details).toEqual([expect.objectContaining({ path })]);
    }
    expect((await audit('flag=malformed')).entries.map((e) => e.action)).toEqual(['flag.create']);
  });

  it('lets only admins require reasons and links, and lists and exports the setting', async () => {
    const denied = await editor.request('PUT', `${P}/environments/development/change-notes`, {
      requireReason: true,
      requireLink: false,
    });
    expect(denied.statusCode).toBe(403);
    const bad = await admin.request('PUT', `${P}/environments/development/change-notes`, {
      requireReason: 'yes',
    });
    expect(bad.statusCode).toBe(400);
    expect(await policy('development', true, true)).toMatchObject({
      key: 'development',
      requiredApprovals: 0,
      requireReason: true,
      requireLink: true,
    });
    const projects = (await viewer.request('GET', '/api/projects')).json().projects;
    const envs = projects.find((p: { key: string }) => p.key === 'default').environments;
    expect(envs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'development', requireReason: true, requireLink: true }),
        expect.objectContaining({ key: 'production', requireReason: false, requireLink: false }),
      ]),
    );
    const [entry] = (await audit('q=change_notes&limit=1')).entries;
    expect(entry).toMatchObject({ action: 'environment.change_notes', targetKey: 'development' });

    const exported = await admin.request('GET', `${P}/export`);
    expect(exported.statusCode).toBe(200);
    const doc = exported.json();
    expect(doc.environments).toEqual(
      expect.arrayContaining([
        { key: 'development', name: 'Development', requireReason: true, requireLink: true },
        { key: 'production', name: 'Production' },
      ]),
    );
    const imported = await admin.request('POST', '/api/projects/import?key=copy', doc);
    expect(imported.statusCode, imported.body).toBe(201);
    const copy = (await viewer.request('GET', '/api/projects'))
      .json()
      .projects.find((p: { key: string }) => p.key === 'copy');
    expect(copy.environments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'development', requireReason: true, requireLink: true }),
      ]),
    );
    await policy('development', false, false);
  });

  it('refuses direct changes without the reason or link their environment requires', async () => {
    const created = await flag('guarded');
    await policy('development', true, false);
    const kill = (extra?: ReturnType<typeof note>) =>
      editor.request(
        'POST',
        `${target('guarded', 'development')}/kill-switch`,
        { enabled: true },
        extra,
      );
    const refused = await kill();
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.message).toBe('changes in development need a reason');
    expect((await kill(note('Turning on for QA'))).statusCode).toBe(200);
    // Other environments are unaffected.
    expect(
      (await editor.request('POST', `${target('guarded')}/kill-switch`, { enabled: true }))
        .statusCode,
    ).toBe(200);

    await policy('development', true, true);
    const noLink = await kill(note('Again'));
    expect(noLink.statusCode).toBe(400);
    expect(noLink.json().error.message).toBe('changes in development need a ticket link');
    const neither = await kill();
    expect(neither.json().error.message).toBe(
      'changes in development need a reason and a ticket link',
    );
    expect(neither.json().error.details.map((d: { path: string }) => d.path)).toEqual([
      'header.flagship-reason',
      'header.flagship-link',
    ]);

    const version = (await viewer.request('GET', `${P}/flags/guarded`)).json().environments
      .development.version;
    const put = (extra?: ReturnType<typeof note>) =>
      editor.request(
        'PUT',
        target('guarded', 'development'),
        {
          version,
          enabled: false,
          offVariant: 'off',
          prerequisites: [],
          rules: [],
          fallthrough: { variant: 'on' },
        },
        extra,
      );
    expect((await put()).statusCode).toBe(400);
    expect((await put(note('QA done', 'https://t.example.com/QA-1'))).statusCode).toBe(200);

    const segment = { key: 'testers', name: 'Testers', included: ['u1'], excluded: [], rules: [] };
    expect((await editor.request('POST', SEG('development'), segment)).statusCode).toBe(400);
    expect(
      (
        await editor.request(
          'POST',
          SEG('development'),
          segment,
          note('QA cohort', 'https://t.example.com/QA-2'),
        )
      ).statusCode,
    ).toBe(201);
    expect(
      (await editor.request('DELETE', `${SEG('development')}/testers?version=1`)).statusCode,
    ).toBe(400);

    const schedule = {
      runAt: new Date(Date.now() + 3_600_000).toISOString(),
      change: { enabled: true },
    };
    const S = `${target('guarded', 'development')}/schedules`;
    expect((await editor.request('POST', S, schedule)).statusCode).toBe(400);
    expect(
      (await editor.request('POST', S, schedule, note('Launch', 'https://t.example.com/L-1')))
        .statusCode,
    ).toBe(201);

    // Project-level changes have no environment and never need one.
    expect(
      (
        await editor.request('PUT', `${P}/flags/guarded`, {
          version: created.version,
          name: 'Guarded',
          description: '',
          clientSide: false,
        })
      ).statusCode,
    ).toBe(200);
    await policy('development', false, false);
  });

  it('records a change request apply with the reason and link it was proposed with', async () => {
    await flag('reviewed');
    const approvals = await admin.request('PUT', `${P}/environments/production/approvals`, {
      requiredApprovals: 1,
    });
    expect(approvals.statusCode).toBe(200);
    await policy('production', true, true);
    const live = (await viewer.request('GET', `${P}/flags/reviewed`)).json().environments
      .production;
    const body = {
      baseVersion: live.version,
      title: 'Open to everyone',
      enabled: true,
      offVariant: live.offVariant,
      prerequisites: [],
      rules: [],
      fallthrough: { variant: 'on' },
    };
    const url = `${target('reviewed')}/change-requests`;
    // The title stands in for the reason, but the link is still required.
    const noLink = await editor.request('POST', url, body);
    expect(noLink.statusCode).toBe(400);
    expect(noLink.json().error.message).toBe('changes in production need a ticket link');
    const opened = await editor.request(
      'POST',
      url,
      body,
      note(undefined, 'https://t.example.com/R-1'),
    );
    expect(opened.statusCode, opened.body).toBe(201);
    const cr = opened.json();
    expect(cr).toMatchObject({ reason: null, link: 'https://t.example.com/R-1' });
    const approve = await other.request('POST', `${P}/change-requests/${cr.id}/reviews`, {
      revision: 1,
      decision: 'approve',
    });
    expect(approve.statusCode, approve.body).toBe(201);
    // The applier gives no note of their own: the request's is recorded.
    const applied = await other.request('POST', `${P}/change-requests/${cr.id}/apply`, {
      revision: 1,
    });
    expect(applied.statusCode, applied.body).toBe(200);
    const [entry] = (await audit('flag=reviewed&limit=1')).entries;
    expect(entry).toMatchObject({
      action: 'flag.change_request.apply',
      actor: 'olga',
      reason: 'Open to everyone',
      link: 'https://t.example.com/R-1',
    });

    // An explicit reason is kept and used instead of the title.
    const second = await editor.request(
      'POST',
      url,
      { ...body, baseVersion: live.version + 1, title: 'Close again', enabled: false },
      note('Rollback: INC-9 conversion drop', 'https://t.example.com/INC-9'),
    );
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json().reason).toBe('Rollback: INC-9 conversion drop');
    await other.request('POST', `${P}/change-requests/${second.json().id}/reviews`, {
      revision: 1,
      decision: 'approve',
    });
    await other.request('POST', `${P}/change-requests/${second.json().id}/apply`, { revision: 1 });
    const [rollback] = (await audit('q=INC-9 apply&limit=1')).entries;
    expect(rollback).toMatchObject({
      action: 'flag.change_request.apply',
      reason: 'Rollback: INC-9 conversion drop',
    });

    await policy('production', false, false);
    await admin.request('PUT', `${P}/environments/production/approvals`, { requiredApprovals: 0 });
  });
});

describe('audit search', () => {
  let projectId: string;
  let environmentId: string;

  beforeAll(async () => {
    const p = await t.db
      .insertInto('projects')
      .values({ key: 'search', name: 'Search' })
      .returning('id')
      .executeTakeFirstOrThrow();
    projectId = p.id;
    const e = await t.db
      .insertInto('environments')
      .values({ project_id: p.id, key: 'production', name: 'Production' })
      .returning('id')
      .executeTakeFirstOrThrow();
    environmentId = e.id;
    // 60 entries over 60 days, several sharing a timestamp so paging has to break ties by id.
    await sql`INSERT INTO audit_log (project_id, environment_id, actor_name, action, target_type,
        target_key, reason, link, created_at)
      SELECT ${projectId}::uuid, ${environmentId}::uuid,
        CASE WHEN i % 3 = 0 THEN 'Ada' ELSE 'Grace' END,
        CASE WHEN i % 2 = 0 THEN 'flag.config.update' ELSE 'segment.update' END,
        CASE WHEN i % 2 = 0 THEN 'flag' ELSE 'segment' END,
        CASE WHEN i % 2 = 0 THEN 'flag-' || (i % 4) ELSE 'segment-' || (i % 5) END,
        CASE WHEN i = 17 THEN 'Rollback after latency incident' WHEN i % 10 = 0 THEN 'Weekly cleanup' END,
        CASE WHEN i = 17 THEN 'https://tickets.example.com/INC-1234' END,
        timestamptz '2026-09-01T00:00:00Z' + ((i / 3) || ' days')::interval
      FROM generate_series(1, 60) AS i`.execute(t.db);
  });

  const S = (query: string) => viewer.request('GET', `/api/projects/search/audit?${query}`);
  const page = async (query: string) => {
    const res = await S(query);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ entries: Entry[]; next: string | null }>();
  };
  const all = async (query: string, limit: number) => {
    const out: Entry[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const p = await page(`${query}&limit=${limit}${cursor === null ? '' : `&cursor=${cursor}`}`);
      out.push(...p.entries);
      cursor = p.next;
      pages++;
    } while (cursor !== null && pages < 100);
    return out;
  };

  it('pages newest first without gaps or repeats, breaking timestamp ties by id', async () => {
    const entries = await all('', 7);
    expect(entries).toHaveLength(60);
    expect(new Set(entries.map((e) => e.id)).size).toBe(60);
    for (let i = 1; i < entries.length; i++) {
      const [a, b] = [entries[i - 1]!, entries[i]!];
      expect(a.at > b.at || (a.at === b.at && a.id > b.id), `${a.id} before ${b.id}`).toBe(true);
    }
    // The last full page says there is nothing more.
    expect((await page('limit=60')).next).toBeNull();
    expect((await page('limit=59')).next).not.toBeNull();
  });

  it('filters by flag, segment, actor, text and dates, alone and combined', async () => {
    expect((await all('flag=flag-2', 4)).map((e) => e.targetKey)).toEqual(Array(15).fill('flag-2'));
    expect((await all('segment=segment-1', 50)).every((e) => e.targetKey === 'segment-1')).toBe(
      true,
    );
    const ada = await all('actor=Ada', 50);
    expect(ada).toHaveLength(20);
    expect(ada.every((e) => e.actor === 'Ada')).toBe(true);
    expect(await all('actor=ada', 50)).toHaveLength(0);

    const latency = await page('q=latency');
    expect(latency.entries.map((e) => e.reason)).toEqual(['Rollback after latency incident']);
    expect(latency.entries[0]).toMatchObject({
      link: 'https://tickets.example.com/INC-1234',
      environment: 'production',
    });
    expect((await page('q=INC-1234')).entries).toHaveLength(1);
    expect((await page('q="latency incident"')).entries).toHaveLength(1);
    expect((await page('q="incident latency"')).entries).toHaveLength(0);
    expect(await all('q=cleanup', 2)).toHaveLength(6);
    expect(await all('q=cleanup -Ada', 50)).toHaveLength(4);
    expect(await all('q=cleanup or latency', 50)).toHaveLength(7);
    expect(await all('q=segment-3', 50)).toHaveLength(6);

    // Day n holds i = 3n .. 3n+2; [Sep 5, Sep 8) is i = 12..20.
    const range = await all('from=2026-09-05T00:00:00Z&to=2026-09-08T00:00:00Z', 4);
    expect(range).toHaveLength(9);
    expect(range.every((e) => e.at >= '2026-09-05' && e.at < '2026-09-08')).toBe(true);
    expect(await all('from=2026-09-05T00:00:00%2B02:00&to=2026-09-05T00:00:00Z', 50)).toHaveLength(
      0,
    );

    const combined = await all(
      'flag=flag-0&actor=Ada&q=cleanup&from=2026-09-01T00:00:00Z&to=2026-10-01T00:00:00Z',
      1,
    );
    // i divisible by 4 (flag-0), 3 (Ada) and 10 (cleanup): 60 only.
    expect(combined.map((e) => e.targetKey)).toEqual(['flag-0']);
  });

  it('refuses contradictory filters and cursors it did not issue', async () => {
    expect((await S('flag=a&segment=b')).statusCode).toBe(400);
    expect((await S('from=2026-09-05T00:00:00Z&to=2026-09-05T00:00:00Z')).statusCode).toBe(400);
    expect((await S('from=yesterday')).statusCode).toBe(400);
    expect((await S(`q=${'x'.repeat(201)}`)).statusCode).toBe(400);
    for (const bad of [
      'nope!',
      Buffer.from('2026-09-01T00:00:00Z|5').toString('base64url'),
      Buffer.from('2026-09-01T00:00:00.000000Z|0').toString('base64url'),
      Buffer.from('2026-09-01T00:00:00.000000Z|5|6').toString('base64url'),
      Buffer.from('2026-13-41T00:00:00.000000Z|5').toString('base64url'),
    ]) {
      const res = await S(`cursor=${bad}`);
      expect(res.statusCode, bad).toBe(400);
      expect(res.json().error.details[0].path).toBe('cursor');
    }
  });

  it('rewrites searches the way the search column is built', () => {
    expect(searchQuery('INC-42')).toBe('"INC 42"');
    expect(searchQuery('-checkout-v2 kill_switch')).toBe('-"checkout v2" "kill switch"');
    expect(searchQuery('latency or "INC-42 rollback"  - x')).toBe(
      'latency or " INC 42 rollback " x',
    );
    expect(searchQuery('"unclosed a.b')).toBe(' " unclosed a b');
    expect(searchQuery('déploiement raté')).toBe('déploiement raté');
  });

  it('round-trips cursors at microsecond precision', () => {
    const c = { at: '2026-09-01T12:34:56.123456Z', id: 42 };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it('keeps the project filter on every search', async () => {
    const other = await page('q=latency');
    expect(other.entries).toHaveLength(1);
    expect(
      (await audit('q=latency')).entries.every(
        (e) => e.reason !== 'Rollback after latency incident',
      ),
    ).toBe(true);
  });
});
