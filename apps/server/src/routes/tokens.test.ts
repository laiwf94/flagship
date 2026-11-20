import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApp, type TestApp } from '../../test/app.js';
import { PASSWORD, signIn, userWithRole, type Client } from '../../test/session.js';
import { requireScopeDeclaration } from '../auth/guard.js';
import { SCOPE_ROLE, SCOPES } from '../auth/scopes.js';
import { pruneApiTokens } from '../services/apitokens.js';

let t: TestApp;
let clock = new Date('2030-01-01T00:00:00Z');
let admin: Client;
let editor: Client;
let viewer: Client;

const P = '/api/projects/default';
const DAY = 86_400_000;

beforeAll(async () => {
  t = await testApp(
    { bootstrapAdmin: { email: 'root@example.com', password: PASSWORD } },
    { now: () => clock },
  );
  admin = await signIn(t.app.server, 'root@example.com');
  editor = await userWithRole(t.app.server, t.db, 'eddie@example.com', 'editor');
  viewer = await userWithRole(t.app.server, t.db, 'vera@example.com', 'viewer');
  const other = await admin.request('POST', '/api/projects', { key: 'other', name: 'Other' });
  expect(other.statusCode, other.body).toBe(201);
  for (const key of ['banner', 'checkout']) {
    const res = await admin.request('POST', `${P}/flags`, { key, name: key, type: 'boolean' });
    expect(res.statusCode, res.body).toBe(201);
  }
});
afterAll(() => t.close());

interface Created {
  id: string;
  secret: string;
  scopes: string[];
  project: string | null;
  environments: string[] | null;
  expiresAt: string;
}

async function mint(client: Client, body: Record<string, unknown>): Promise<Created> {
  const res = await client.request('POST', '/api/tokens', { expiresInDays: 30, ...body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<Created>();
}

/** A request carrying only the token: no cookie, no CSRF token. */
function withToken(
  secret: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: object,
  headers: Record<string, string> = {},
) {
  return t.app.server.inject({
    method,
    url,
    headers: { authorization: `Bearer ${secret}`, ...headers },
    ...(payload === undefined ? {} : { payload }),
  });
}

const kill = (secret: string, env: string, enabled = true) =>
  withToken(secret, 'POST', `${P}/flags/banner/environments/${env}/kill-switch`, { enabled });

describe('creating and listing tokens', () => {
  it('shows the secret once and lists the token without it, scopes in catalogue order', async () => {
    const created = await mint(editor, {
      name: 'deploy bot',
      scopes: ['flags:write', 'audit:read', 'flags:read'],
    });
    expect(created.secret).toMatch(/^fst_[\w-]{43}$/);
    expect(created).toMatchObject({
      scopes: ['flags:read', 'flags:write', 'audit:read'],
      project: null,
      environments: null,
      expiresAt: new Date(clock.getTime() + 30 * DAY).toISOString(),
    });

    const list = await editor.request('GET', '/api/tokens');
    expect(list.statusCode).toBe(200);
    const body = list.json<{ tokens: Record<string, unknown>[]; scopes: string[] }>();
    expect(body.scopes).toEqual([...SCOPES]);
    const listed = body.tokens.find((x) => x.id === created.id);
    expect(listed).toMatchObject({
      name: 'deploy bot',
      displayPrefix: created.secret.slice(0, 12),
      revoked: false,
      expired: false,
      lastUsedAt: null,
    });
    expect(JSON.stringify(body)).not.toContain(created.secret);
    // Only the hash is stored.
    const stored = await t.db
      .selectFrom('api_tokens')
      .select('token_hash')
      .where('id', '=', created.id)
      .executeTakeFirstOrThrow();
    expect(stored.token_hash.toString('utf8')).not.toContain(created.secret.slice(4));

    // Each user only sees their own.
    const others = await viewer.request('GET', '/api/tokens');
    expect(others.json<{ tokens: unknown[] }>().tokens).toEqual([]);

    const audit = await t.db
      .selectFrom('audit_log')
      .select(['actor_name', 'target_key', 'after'])
      .where('action', '=', 'api_token.create')
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(audit.actor_name).toBe('eddie');
    expect(audit.target_key).toBe(`deploy bot (${created.secret.slice(0, 12)}…)`);
    expect(JSON.stringify(audit.after)).not.toContain(created.secret);
  });

  it('refuses scopes above the creator’s role', async () => {
    const res = await viewer.request('POST', '/api/tokens', {
      name: 'too much',
      scopes: ['flags:read', 'flags:write'],
      expiresInDays: 1,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      error: { message: expect.stringContaining('flags:write') },
    });
    const editorAdmin = await editor.request('POST', '/api/tokens', {
      name: 'hooks',
      scopes: ['webhooks:write'],
      expiresInDays: 1,
    });
    expect(editorAdmin.statusCode).toBe(403);
    // Every scope is grantable by an admin, and read scopes by a viewer where the role allows.
    for (const scope of SCOPES) {
      const client = SCOPE_ROLE[scope] === 'viewer' ? viewer : admin;
      await mint(client, { name: scope, scopes: [scope], expiresInDays: 1 });
    }
  });

  it('validates the expiry, scopes, project and environments', async () => {
    const bad = async (body: Record<string, unknown>, status = 400) => {
      const res = await admin.request('POST', '/api/tokens', {
        name: 'x',
        scopes: ['flags:read'],
        expiresInDays: 30,
        ...body,
      });
      expect(res.statusCode, res.body).toBe(status);
      return res;
    };
    await bad({ expiresInDays: 0 });
    await bad({ expiresInDays: 366 });
    await bad({ expiresInDays: undefined });
    await bad({ scopes: [] });
    await bad({ scopes: ['flags:admin'] });
    await bad({ name: '  ' });
    await bad({ environments: ['production'] });
    await bad({ project: 'nope' }, 404);
    await bad({ project: 'default', environments: ['nope'] }, 404);
    await bad({ extra: true });
  });
});

describe('authorizing requests with a token', () => {
  it('reads and writes without a cookie or CSRF token, and audits the token as the actor', async () => {
    const token = await mint(editor, { name: 'ci', scopes: ['flags:read', 'flags:write'] });
    const list = await withToken(token.secret, 'GET', `${P}/flags?environment=development`);
    expect(list.statusCode, list.body).toBe(200);
    const res = await kill(token.secret, 'production');
    expect(res.statusCode, res.body).toBe(200);
    const audit = await t.db
      .selectFrom('audit_log')
      .select(['actor_name', 'actor_id'])
      .where('target_key', '=', 'banner')
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(audit).toEqual({ actor_name: 'eddie (token ci)', actor_id: editor.userId });
    const used = await t.db
      .selectFrom('api_tokens')
      .select('last_used_at')
      .where('id', '=', token.id)
      .executeTakeFirstOrThrow();
    expect(used.last_used_at).toEqual(clock);
    await kill(token.secret, 'production', false);
  });

  it('refuses routes outside the token’s scopes', async () => {
    const token = await mint(editor, { name: 'reader', scopes: ['flags:read'] });
    const res = await kill(token.secret, 'production');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      error: { code: 'permission_denied', message: 'this token lacks the flags:write scope' },
    });
    const segments = await withToken(token.secret, 'GET', `${P}/environments/production/segments`);
    expect(segments.statusCode).toBe(403);
  });

  it('never reaches session, user or token management', async () => {
    const all = await mint(admin, { name: 'everything', scopes: [...SCOPES] });
    for (const [method, url] of [
      ['GET', '/api/session'],
      ['DELETE', '/api/session'],
      ['PUT', '/api/session/password'],
      ['GET', '/api/users'],
      ['POST', '/api/users'],
      ['GET', '/api/tokens'],
      ['POST', '/api/tokens'],
      ['DELETE', `/api/tokens/${all.id}`],
    ] as const) {
      const res = await withToken(all.secret, method, url, method === 'GET' ? undefined : {});
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json()).toMatchObject({
        error: { message: 'API tokens cannot use this route; sign in instead' },
      });
    }
  });

  it('limits a project token to its project', async () => {
    const token = await mint(admin, {
      name: 'default only',
      project: 'default',
      scopes: ['flags:read', 'projects:read'],
    });
    expect(token.project).toBe('default');
    expect(
      (await withToken(token.secret, 'GET', `${P}/flags?environment=development`)).statusCode,
    ).toBe(200);
    const other = await withToken(token.secret, 'GET', '/api/projects/other/flags');
    expect(other.statusCode).toBe(403);
    expect(other.json()).toMatchObject({
      error: { message: 'this token is limited to project "default"' },
    });
    // Routes that span projects are refused too.
    expect((await withToken(token.secret, 'GET', '/api/projects')).statusCode).toBe(403);
    const unbound = await mint(admin, { name: 'all projects', scopes: ['projects:read'] });
    expect((await withToken(unbound.secret, 'GET', '/api/projects')).statusCode).toBe(200);
  });

  it('lets an environment token write only to its environments, and read project-wide', async () => {
    const token = await mint(editor, {
      name: 'dev bot',
      project: 'default',
      environments: ['development'],
      scopes: ['flags:read', 'flags:write'],
    });
    expect(token.environments).toEqual(['development']);
    expect((await kill(token.secret, 'development')).statusCode).toBe(200);
    await kill(token.secret, 'development', false);
    const prod = await kill(token.secret, 'production');
    expect(prod.statusCode).toBe(403);
    expect(prod.json()).toMatchObject({
      error: { message: 'this token is limited to the development environment' },
    });
    // Project-level reads work; project-level writes don't, since they reach every environment.
    expect((await withToken(token.secret, 'GET', `${P}/flags/banner`)).statusCode).toBe(200);
    const create = await withToken(token.secret, 'POST', `${P}/flags`, {
      key: 'from-dev',
      name: 'From dev',
      type: 'boolean',
    });
    expect(create.statusCode).toBe(403);
    const ruleset = await withToken(token.secret, 'GET', `${P}/environments/production/ruleset`);
    expect(ruleset.statusCode).toBe(403);
  });

  it('follows the owner: a role change narrows the token and disabling the owner ends it', async () => {
    const owner = await userWithRole(t.app.server, t.db, 'olga@example.com', 'editor');
    const token = await mint(owner, { name: 'olga bot', scopes: ['flags:read', 'flags:write'] });
    expect((await kill(token.secret, 'development')).statusCode).toBe(200);
    await kill(token.secret, 'development', false);

    const demote = await admin.request('PATCH', `/api/users/${owner.userId}`, { role: 'viewer' });
    expect(demote.statusCode, demote.body).toBe(200);
    const denied = await kill(token.secret, 'development');
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: { message: 'this needs the editor role' } });
    expect(
      (await withToken(token.secret, 'GET', `${P}/flags?environment=development`)).statusCode,
    ).toBe(200);

    await admin.request('PATCH', `/api/users/${owner.userId}`, { disabled: true });
    const gone = await withToken(token.secret, 'GET', `${P}/flags?environment=development`);
    expect(gone.statusCode).toBe(401);
  });

  it('stops working once expired', async () => {
    const token = await mint(viewer, { name: 'short', scopes: ['flags:read'], expiresInDays: 1 });
    const start = clock;
    try {
      clock = new Date(start.getTime() + DAY - 1);
      expect(
        (await withToken(token.secret, 'GET', `${P}/flags?environment=development`)).statusCode,
      ).toBe(200);
      clock = new Date(start.getTime() + DAY);
      const res = await withToken(token.secret, 'GET', `${P}/flags?environment=development`);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({
        error: { code: 'unauthenticated', message: 'unknown, expired or revoked API token' },
      });
      // A day on, the viewer's session has expired too; sign in again to list.
      const fresh = await signIn(t.app.server, 'vera@example.com');
      const listed = await fresh.request('GET', '/api/tokens');
      expect(
        listed
          .json<{ tokens: { id: string; expired: boolean }[] }>()
          .tokens.find((x) => x.id === token.id)?.expired,
      ).toBe(true);
    } finally {
      clock = start;
      viewer = await signIn(t.app.server, 'vera@example.com');
    }
  });

  it('refuses unknown and malformed tokens, and ignores the cookie when a token is given', async () => {
    for (const raw of ['fst_' + 'a'.repeat(43), 'fst_short', 'fss_' + 'a'.repeat(43), '']) {
      const res = await withToken(raw, 'GET', `${P}/flags?environment=development`);
      expect(res.statusCode, raw).toBe(401);
    }
    const res = await t.app.server.inject({
      method: 'GET',
      url: `${P}/flags`,
      headers: { authorization: `Bearer fst_${'b'.repeat(43)}`, cookie: admin.cookie },
    });
    expect(res.statusCode).toBe(401);
  });

  it('still refuses cross-origin writes', async () => {
    const token = await mint(editor, { name: 'origin', scopes: ['flags:write'] });
    const res = await withToken(
      token.secret,
      'POST',
      `${P}/flags/banner/environments/development/kill-switch`,
      { enabled: true },
      { origin: 'https://evil.example' },
    );
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { message: 'cross-origin request refused' } });
  });

  it('keeps token secrets out of the logs', async () => {
    const token = await mint(editor, { name: 'quiet', scopes: ['flags:read'] });
    await withToken(token.secret, 'GET', `${P}/flags?environment=production`);
    await withToken(token.secret, 'GET', '/api/session');
    expect(t.logs.join('\n')).not.toContain(token.secret);
  });
});

describe('revoking and pruning', () => {
  it('lets the owner or an admin revoke, and nobody else', async () => {
    const token = await mint(editor, { name: 'revoke me', scopes: ['flags:read'] });
    const stranger = await viewer.request('DELETE', `/api/tokens/${token.id}`);
    expect(stranger.statusCode).toBe(404);
    expect(
      (await withToken(token.secret, 'GET', `${P}/flags?environment=development`)).statusCode,
    ).toBe(200);

    expect((await editor.request('DELETE', `/api/tokens/${token.id}`)).statusCode).toBe(204);
    expect(
      (await withToken(token.secret, 'GET', `${P}/flags?environment=development`)).statusCode,
    ).toBe(401);
    expect((await editor.request('DELETE', `/api/tokens/${token.id}`)).statusCode).toBe(404);

    const second = await mint(editor, { name: 'admin revokes', scopes: ['flags:read'] });
    expect((await admin.request('DELETE', `/api/tokens/${second.id}`)).statusCode).toBe(204);
    expect(
      (await withToken(second.secret, 'GET', `${P}/flags?environment=development`)).statusCode,
    ).toBe(401);

    const audit = await t.db
      .selectFrom('audit_log')
      .select(['actor_name', 'target_key'])
      .where('action', '=', 'api_token.revoke')
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(audit).toEqual({
      actor_name: 'Admin',
      target_key: `admin revokes (${second.secret.slice(0, 12)}…)`,
    });
  });

  it('deletes tokens 30 days after they expire or are revoked', async () => {
    const owner = await userWithRole(t.app.server, t.db, 'pru@example.com', 'viewer');
    const expiring = await mint(owner, {
      name: 'expiring',
      scopes: ['flags:read'],
      expiresInDays: 1,
    });
    const revoked = await mint(owner, {
      name: 'revoked',
      scopes: ['flags:read'],
      expiresInDays: 90,
    });
    const live = await mint(owner, { name: 'live', scopes: ['flags:read'], expiresInDays: 90 });
    await owner.request('DELETE', `/api/tokens/${revoked.id}`);
    const prune = pruneApiTokens(t.db);
    const ids = async () =>
      (
        await t.db
          .selectFrom('api_tokens')
          .select('id')
          .where('id', 'in', [expiring.id, revoked.id, live.id])
          .execute()
      )
        .map((r) => r.id)
        .sort();
    await prune(new Date(clock.getTime() + 30 * DAY));
    expect(await ids()).toEqual([expiring.id, revoked.id, live.id].sort());
    await prune(new Date(clock.getTime() + 32 * DAY));
    expect(await ids()).toEqual([live.id]);
  });
});

describe('route declarations', () => {
  it('requires every /api route to declare exactly one of public, scope or sessionOnly', () => {
    expect(() => {
      requireScopeDeclaration({ method: 'GET', url: '/api/new', config: {} });
    }).toThrow('GET /api/new must declare exactly one of public, scope or sessionOnly');
    expect(() => {
      requireScopeDeclaration({
        method: ['GET', 'HEAD'],
        url: '/api/both',
        config: { scope: 'flags:read', sessionOnly: true },
      });
    }).toThrow('GET,HEAD /api/both');
    expect(() => {
      requireScopeDeclaration({ method: 'GET', url: '/api/x' });
    }).toThrow();
    requireScopeDeclaration({ method: 'GET', url: '/api/x', config: { scope: 'flags:read' } });
  });
});
