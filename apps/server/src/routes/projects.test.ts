import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApp, type TestApp } from '../../test/app.js';
import { PASSWORD, signIn, userWithRole, type Client } from '../../test/session.js';
import { authenticateSdk } from '../auth/sdk.js';

let t: TestApp;
let admin: Client;
let editor: Client;

beforeAll(async () => {
  t = await testApp({ bootstrapAdmin: { email: 'root@example.com', password: PASSWORD } });
  admin = await signIn(t.app.server, 'root@example.com');
  editor = await userWithRole(t.app.server, t.db, 'eddie@example.com', 'editor');
});
afterAll(() => t.close());

const sdk = (key: string | undefined, url = '/sdk/v1/environment') =>
  t.app.server.inject({
    url,
    ...(key === undefined ? {} : { headers: { authorization: `Bearer ${key}` } }),
  });

describe('projects and environments', () => {
  it('bootstraps a default project with two environments', async () => {
    const res = await editor.request('GET', '/api/projects');
    expect(res.json()).toEqual({
      projects: [
        {
          key: 'default',
          name: 'Default project',
          environments: [
            { key: 'development', name: 'Development' },
            { key: 'production', name: 'Production' },
          ],
        },
      ],
    });
  });

  it('lets admins create projects and environments, and nobody else', async () => {
    const denied = await editor.request('POST', '/api/projects', { key: 'shop', name: 'Shop' });
    expect(denied.statusCode).toBe(403);
    const created = await admin.request('POST', '/api/projects', {
      key: 'shop',
      name: 'Shop',
      environments: [{ key: 'staging', name: 'Staging' }],
    });
    expect(created.statusCode).toBe(201);
    expect(
      (await admin.request('POST', '/api/projects', { key: 'shop', name: 'x' })).statusCode,
    ).toBe(409);
    const env = await admin.request('POST', '/api/projects/shop/environments', {
      key: 'production',
      name: 'Production',
    });
    expect(env.statusCode).toBe(201);
    const again = await admin.request('POST', '/api/projects/shop/environments', {
      key: 'production',
      name: 'Production',
    });
    expect(again.statusCode).toBe(409);
    const missing = await admin.request('POST', '/api/projects/ghost/environments', {
      key: 'x',
      name: 'X',
    });
    expect(missing.statusCode).toBe(404);
    const bad = await admin.request('POST', '/api/projects', { key: 'has space', name: 'x' });
    expect(bad.statusCode).toBe(400);
  });
});

describe('API keys', () => {
  it('shows the secret once, stores only a prefix, and authenticates SDKs', async () => {
    const url = '/api/projects/default/environments/production/api-keys';
    const created = await admin.request('POST', url, { kind: 'server', name: 'checkout service' });
    expect(created.statusCode).toBe(201);
    const key = created.json();
    expect(key.secret).toMatch(/^fss_[\w-]{43}$/);
    expect(key.displayPrefix).toBe(key.secret.slice(0, 12));

    const list = await admin.request('GET', url);
    expect(list.body).not.toContain(key.secret);
    expect(list.json().keys[0]).toMatchObject({ name: 'checkout service', revoked: false });

    const who = await sdk(key.secret);
    expect(who.json()).toEqual({
      project: 'default',
      environment: 'production',
      keyKind: 'server',
    });
    const used = await admin.request('GET', url);
    expect(used.json().keys[0].lastUsedAt).not.toBeNull();

    const stored = await t.db.selectFrom('api_keys').select('key_hash').execute();
    expect(JSON.stringify(stored)).not.toContain(key.secret);
  });

  it('refuses missing, malformed, unknown and revoked keys', async () => {
    const url = '/api/projects/default/environments/development/api-keys';
    const key = (await admin.request('POST', url, { kind: 'client', name: 'web' })).json();
    expect(key.secret).toMatch(/^fsc_/);
    expect((await sdk(key.secret)).json().keyKind).toBe('client');

    expect((await sdk(undefined)).statusCode).toBe(401);
    expect((await sdk('not-a-key')).statusCode).toBe(401);
    expect((await sdk(`fss_${'A'.repeat(43)}`)).statusCode).toBe(401);

    const revoked = await admin.request('DELETE', `${url}/${key.id}`);
    expect(revoked.statusCode).toBe(204);
    expect((await sdk(key.secret)).statusCode).toBe(401);
    expect((await admin.request('DELETE', `${url}/${key.id}`)).statusCode).toBe(404);

    const actions = await t.db
      .selectFrom('audit_log')
      .select('action')
      .where('target_type', '=', 'api_key')
      .execute();
    expect(actions.map((a) => a.action)).toEqual([
      'api_key.create',
      'api_key.create',
      'api_key.revoke',
    ]);
  });

  it('keeps keys inside their environment', async () => {
    const prod = '/api/projects/default/environments/production/api-keys';
    const dev = '/api/projects/default/environments/development/api-keys';
    const key = (await admin.request('POST', prod, { kind: 'server', name: 'x' })).json();
    expect((await admin.request('DELETE', `${dev}/${key.id}`)).statusCode).toBe(404);
    expect((await editor.request('GET', prod)).statusCode).toBe(403);
    expect((await admin.request('POST', prod, { kind: 'root', name: 'x' })).statusCode).toBe(400);
  });

  it('accepts only client keys from the query string, and enforces key kinds', async () => {
    const url = '/api/projects/default/environments/production/api-keys';
    const server = (await admin.request('POST', url, { kind: 'server', name: 's' })).json();
    const client = (await admin.request('POST', url, { kind: 'client', name: 'c' })).json();
    const request = (headers: Record<string, string>, query: Record<string, string>) =>
      ({ headers, query }) as never;

    await expect(
      authenticateSdk(t.app.ctx.keys, request({}, { key: client.secret }), ['client'], true),
    ).resolves.toMatchObject({ kind: 'client' });
    await expect(
      authenticateSdk(t.app.ctx.keys, request({}, { key: server.secret }), ['server'], true),
    ).rejects.toThrow('an SDK key is required');
    await expect(
      authenticateSdk(t.app.ctx.keys, request({}, { key: client.secret }), ['client']),
    ).rejects.toThrow('an SDK key is required');
    await expect(
      authenticateSdk(t.app.ctx.keys, request({ authorization: `Bearer ${client.secret}` }, {}), [
        'server',
      ]),
    ).rejects.toThrow('needs a server key');
    await expect(
      authenticateSdk(t.app.ctx.keys, request({ authorization: `Bearer ${server.secret}` }, {}), [
        'client',
      ]),
    ).rejects.toThrow('needs a client key');
  });
});
