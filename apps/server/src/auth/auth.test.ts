import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApp, type TestApp } from '../../test/app.js';
import { addUser, PASSWORD, signIn, userWithRole, type Client } from '../../test/session.js';
import { bootstrapAdmin } from '../services/users.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { FailureLimiter } from './ratelimit.js';
import { pruneExpiredSessions } from './sessions.js';

let t: TestApp;
let clock = new Date('2030-01-01T00:00:00Z');
let admin: Client;
let viewer: Client;
let editor: Client;

beforeAll(async () => {
  t = await testApp(
    { bootstrapAdmin: { email: 'root@example.com', password: PASSWORD } },
    { now: () => clock },
  );
  admin = await signIn(t.app.server, 'root@example.com');
  viewer = await userWithRole(t.app.server, t.db, 'vera@example.com', 'viewer');
  editor = await userWithRole(t.app.server, t.db, 'eddie@example.com', 'editor');
});
afterAll(() => t.close());

async function refreshClients(): Promise<void> {
  admin = await signIn(t.app.server, 'root@example.com');
  viewer = await signIn(t.app.server, 'vera@example.com');
  editor = await signIn(t.app.server, 'eddie@example.com');
}

describe('sign-in', () => {
  it('sets an httpOnly, SameSite=Lax session cookie and returns a CSRF token', async () => {
    const res = await t.app.server.inject({
      method: 'POST',
      url: '/api/session',
      payload: { email: 'ROOT@example.com ', password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/^flagship_session=[\w-]{43};/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toContain('Secure');
    expect(res.json()).toMatchObject({
      user: { email: 'root@example.com', role: 'admin' },
      csrfToken: expect.stringMatching(/^[\w-]{43}$/),
    });
  });

  it('marks the cookie Secure behind HTTPS or when forced', async () => {
    const forced = await testApp({ cookieSecure: 'true' });
    const proxied = await testApp({ trustProxy: true });
    try {
      await addUser(forced.db, 'a@example.com', 'viewer');
      await addUser(proxied.db, 'a@example.com', 'viewer');
      const body = { email: 'a@example.com', password: PASSWORD };
      const f = await forced.app.server.inject({
        method: 'POST',
        url: '/api/session',
        payload: body,
      });
      expect(String(f.headers['set-cookie'])).toContain('Secure');
      const p = await proxied.app.server.inject({
        method: 'POST',
        url: '/api/session',
        payload: body,
        headers: { 'x-forwarded-proto': 'https' },
      });
      expect(String(p.headers['set-cookie'])).toContain('Secure');
    } finally {
      await forced.close();
      await proxied.close();
    }
  });

  it('gives the same answer for an unknown email and a wrong password', async () => {
    const unknown = await t.app.server.inject({
      method: 'POST',
      url: '/api/session',
      payload: { email: 'nobody@example.com', password: PASSWORD },
    });
    const wrong = await t.app.server.inject({
      method: 'POST',
      url: '/api/session',
      payload: { email: 'root@example.com', password: 'not the password' },
    });
    expect(unknown.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(unknown.json().error.message).toBe(wrong.json().error.message);
  });

  it('locks an email out after ten failures and says when to retry', async () => {
    await addUser(t.db, 'target@example.com', 'viewer');
    const attempt = (password: string) =>
      t.app.server.inject({
        method: 'POST',
        url: '/api/session',
        payload: { email: 'target@example.com', password },
        remoteAddress: '10.1.1.1',
      });
    for (let i = 0; i < 10; i++) expect((await attempt('wrong')).statusCode).toBe(401);
    const blocked = await attempt(PASSWORD);
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    clock = new Date(clock.getTime() + 16 * 60_000);
    expect((await attempt(PASSWORD)).statusCode).toBe(200);
    await refreshClients();
  });

  it('refuses a cross-origin sign-in and form-encoded bodies', async () => {
    const cross = await t.app.server.inject({
      method: 'POST',
      url: '/api/session',
      payload: { email: 'root@example.com', password: PASSWORD },
      headers: { origin: 'https://evil.example' },
    });
    expect(cross.statusCode).toBe(403);
    const form = await t.app.server.inject({
      method: 'POST',
      url: '/api/session',
      payload: `email=root@example.com&password=${PASSWORD}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(form.statusCode).toBe(415);
    const same = await t.app.server.inject({
      method: 'POST',
      url: '/api/session',
      payload: { email: 'root@example.com', password: PASSWORD },
      headers: { origin: 'http://localhost:80', host: 'localhost:80' },
    });
    expect(same.statusCode).toBe(200);
  });

  it('never writes session tokens or passwords to the log', async () => {
    const res = await t.app.server.inject({
      method: 'POST',
      url: '/api/session',
      payload: { email: 'root@example.com', password: PASSWORD },
    });
    const token = String(res.headers['set-cookie']).split(';')[0]?.split('=')[1] ?? '';
    await t.app.server.inject({
      url: '/api/session',
      headers: { cookie: `flagship_session=${token}` },
    });
    const logs = t.logs.join('');
    expect(token.length).toBe(43);
    expect(logs).not.toContain(token);
    expect(logs).not.toContain(PASSWORD);
    expect(logs).not.toContain(admin.csrf);
  });
});

describe('sessions', () => {
  it('returns the current user and CSRF token', async () => {
    const res = await viewer.request('GET', '/api/session');
    expect(res.json()).toEqual({
      user: { id: viewer.userId, email: 'vera@example.com', name: 'vera', role: 'viewer' },
      csrfToken: viewer.csrf,
    });
  });

  it('rejects missing, unknown and oversized cookies', async () => {
    for (const cookie of [
      undefined,
      'flagship_session=nope',
      `flagship_session=${'x'.repeat(200)}`,
    ]) {
      const res = await t.app.server.inject({
        url: '/api/session',
        ...(cookie === undefined ? {} : { headers: { cookie } }),
      });
      expect(res.statusCode).toBe(401);
    }
  });

  it('expires after the idle timeout and slides while in use', async () => {
    const c = await signIn(t.app.server, 'vera@example.com');
    clock = new Date(clock.getTime() + 11 * 3_600_000);
    expect((await c.request('GET', '/api/session')).statusCode).toBe(200);
    clock = new Date(clock.getTime() + 11 * 3_600_000);
    expect((await c.request('GET', '/api/session')).statusCode).toBe(200);
    clock = new Date(clock.getTime() + 13 * 3_600_000);
    expect((await c.request('GET', '/api/session')).statusCode).toBe(401);
  });

  it('expires at the absolute limit even when active', async () => {
    const c = await signIn(t.app.server, 'vera@example.com');
    let lastOk = 0;
    for (let h = 10; h <= 8 * 24; h += 10) {
      clock = new Date(clock.getTime() + 10 * 3_600_000);
      const res = await c.request('GET', '/api/session');
      if (res.statusCode !== 200) break;
      lastOk = h;
    }
    expect(lastOk).toBeGreaterThanOrEqual(7 * 24 - 10);
    expect(lastOk).toBeLessThan(7 * 24);
    await refreshClients();
  });

  it('signs out and clears the cookie', async () => {
    const c = await signIn(t.app.server, 'vera@example.com');
    const out = await c.request('DELETE', '/api/session');
    expect(out.statusCode).toBe(204);
    expect(String(out.headers['set-cookie'])).toContain('flagship_session=;');
    expect((await c.request('GET', '/api/session')).statusCode).toBe(401);
  });

  it('prunes expired sessions', async () => {
    await signIn(t.app.server, 'vera@example.com');
    const pruned = await pruneExpiredSessions(t.db, new Date(clock.getTime() + 400 * 3_600_000));
    expect(pruned).toBeGreaterThan(0);
    await refreshClients();
  });
});

describe('CSRF and origin', () => {
  it('requires the CSRF token on state-changing requests', async () => {
    const body = { email: 'x1@example.com', name: 'X', role: 'viewer', password: PASSWORD };
    const none = await t.app.server.inject({
      method: 'POST',
      url: '/api/users',
      payload: body,
      headers: { cookie: admin.cookie },
    });
    expect(none.statusCode).toBe(403);
    expect(none.json().error.message).toBe('missing or invalid CSRF token');
    const wrong = await admin.request('POST', '/api/users', body, {
      headers: { 'x-csrf-token': viewer.csrf },
    });
    expect(wrong.statusCode).toBe(403);
    const ok = await admin.request('POST', '/api/users', body);
    expect(ok.statusCode).toBe(201);
  });

  it('refuses cross-origin writes even with a valid token, unless the origin is allowed', async () => {
    const body = { email: 'x2@example.com', name: 'X', role: 'viewer', password: PASSWORD };
    const evil = await admin.request('POST', '/api/users', body, {
      headers: { origin: 'https://evil.example' },
    });
    expect(evil.statusCode).toBe(403);
    expect(evil.json().error.message).toBe('cross-origin request refused');

    const allowed = await testApp({ allowedOrigins: ['https://flags.acme.com'] });
    try {
      await addUser(allowed.db, 'a@example.com', 'admin');
      const c = await signIn(allowed.app.server, 'a@example.com');
      const res = await c.request('POST', '/api/users', body, {
        headers: { origin: 'https://flags.acme.com' },
      });
      expect(res.statusCode).toBe(201);
    } finally {
      await allowed.close();
    }
  });
});

describe('roles', () => {
  it.each([
    ['viewer', 403],
    ['editor', 403],
    ['admin', 200],
  ] as const)('%s on admin routes gets %d', async (role, status) => {
    const c = { viewer, editor, admin }[role];
    expect((await c.request('GET', '/api/users')).statusCode).toBe(status);
  });

  it('lets every role read its own session', async () => {
    for (const c of [viewer, editor, admin]) {
      expect((await c.request('GET', '/api/session')).statusCode).toBe(200);
    }
  });
});

describe('user management', () => {
  it('creates, lists and updates users with audit entries', async () => {
    const created = await admin.request('POST', '/api/users', {
      email: 'New.Person@Example.com',
      name: 'New Person',
      role: 'viewer',
      password: PASSWORD,
    });
    expect(created.statusCode).toBe(201);
    const user = created.json();
    expect(user).toMatchObject({
      email: 'new.person@example.com',
      role: 'viewer',
      disabled: false,
    });

    const dup = await admin.request('POST', '/api/users', {
      email: 'new.person@example.com',
      name: 'Again',
      role: 'viewer',
      password: PASSWORD,
    });
    expect(dup.statusCode).toBe(409);

    const weak = await admin.request('POST', '/api/users', {
      email: 'weak@example.com',
      name: 'Weak',
      role: 'viewer',
      password: 'short',
    });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().error.details).toEqual([
      { path: 'password', message: 'use at least 12 characters' },
    ]);

    const session = await signIn(t.app.server, 'new.person@example.com');
    const promoted = await admin.request('PATCH', `/api/users/${user.id}`, {
      role: 'editor',
      name: 'N P',
    });
    expect(promoted.json()).toMatchObject({ role: 'editor', name: 'N P' });
    expect((await session.request('GET', '/api/session')).statusCode).toBe(401);

    const list = await admin.request('GET', '/api/users');
    expect(list.json().users.map((u: { email: string }) => u.email)).toContain(
      'new.person@example.com',
    );

    const audit = await t.db
      .selectFrom('audit_log')
      .select(['action', 'target_key', 'before', 'after'])
      .where('target_key', '=', 'new.person@example.com')
      .orderBy('id')
      .execute();
    expect(audit.map((a) => a.action)).toEqual(['user.create', 'user.update']);
    expect(audit[1]?.before).toMatchObject({ role: 'viewer' });
    expect(audit[1]?.after).toMatchObject({ role: 'editor' });
  });

  it('disables a user, ends their sessions and blocks sign-in', async () => {
    const id = await addUser(t.db, 'leaver@example.com', 'editor');
    const c = await signIn(t.app.server, 'leaver@example.com');
    const res = await admin.request('PATCH', `/api/users/${id}`, { disabled: true });
    expect(res.json().disabled).toBe(true);
    expect((await c.request('GET', '/api/session')).statusCode).toBe(401);
    await expect(signIn(t.app.server, 'leaver@example.com')).rejects.toThrow(/401/);
    const back = await admin.request('PATCH', `/api/users/${id}`, { disabled: false });
    expect(back.json().disabled).toBe(false);
    const nothing = await admin.request('PATCH', `/api/users/${id}`, {});
    expect(nothing.statusCode).toBe(200);
  });

  it("doesn't let an admin lock themselves out", async () => {
    const res = await admin.request('PATCH', `/api/users/${admin.userId}`, { role: 'viewer' });
    expect(res.statusCode).toBe(400);
    const missing = await admin.request(
      'PATCH',
      '/api/users/00000000-0000-4000-8000-000000000000',
      { name: 'x' },
    );
    expect(missing.statusCode).toBe(404);
    const badId = await admin.request('PATCH', '/api/users/nope', { name: 'x' });
    expect(badId.statusCode).toBe(400);
  });

  it('changes a password and signs out other sessions', async () => {
    await addUser(t.db, 'pw@example.com', 'viewer');
    const a = await signIn(t.app.server, 'pw@example.com');
    const b = await signIn(t.app.server, 'pw@example.com');
    const wrong = await a.request('PUT', '/api/session/password', {
      currentPassword: 'nope',
      newPassword: 'another long password',
    });
    expect(wrong.statusCode).toBe(400);
    const ok = await a.request('PUT', '/api/session/password', {
      currentPassword: PASSWORD,
      newPassword: 'another long password',
    });
    expect(ok.statusCode).toBe(204);
    expect((await a.request('GET', '/api/session')).statusCode).toBe(200);
    expect((await b.request('GET', '/api/session')).statusCode).toBe(401);
    await expect(signIn(t.app.server, 'pw@example.com')).rejects.toThrow();
    await signIn(t.app.server, 'pw@example.com', 'another long password');
  });
});

describe('bootstrap', () => {
  it('creates the first admin once and never again', async () => {
    expect(
      await bootstrapAdmin(t.db, { email: 'other@example.com', password: PASSWORD }),
    ).toBeUndefined();
    expect(await bootstrapAdmin(t.db, undefined)).toBeUndefined();
  });
});

describe('passwords', () => {
  it('verifies its own hashes and rejects tampered or foreign formats', async () => {
    const hash = await hashPassword('pässword with ümlauts');
    expect(await verifyPassword('pässword with ümlauts', hash)).toBe(true);
    expect(await verifyPassword('password with umlauts', hash)).toBe(false);
    expect(await verifyPassword('x', 'bcrypt$2b$...')).toBe(false);
    expect(await verifyPassword('x', hash.replace('$32768$', '$99999999$'))).toBe(false);
    expect(await verifyPassword('x', `${hash.slice(0, -8)}AAAA`)).toBe(false);
  });
});

describe('FailureLimiter', () => {
  it('slides the window and stays bounded', () => {
    const l = new FailureLimiter(2, 1000, 3);
    l.fail('a', 0);
    l.fail('a', 100);
    expect(l.retryAfter('a', 200)).toBe(800);
    expect(l.retryAfter('a', 1001)).toBe(0);
    l.fail('b', 0);
    l.fail('c', 0);
    l.fail('d', 0);
    expect(l.size).toBeLessThanOrEqual(3);
    l.reset('d');
    expect(l.retryAfter('d', 0)).toBe(0);
  });
});
