import type { AddressInfo } from 'node:net';
import { AdminApiError, AdminClient } from '@flagship/admin-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApp, type TestApp } from '../test/app.js';
import { PASSWORD } from '../test/session.js';

let t: TestApp;
let baseUrl: string;
let admin: AdminClient;

beforeAll(async () => {
  t = await testApp({ bootstrapAdmin: { email: 'root@example.com', password: PASSWORD } });
  await t.app.server.listen({ host: '127.0.0.1', port: 0 });
  const { port } = t.app.server.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  admin = await AdminClient.login({ baseUrl }, 'root@example.com', PASSWORD);
});
afterAll(() => t.close());

describe('the generated admin client against the server', () => {
  it('signs in with a session and makes CSRF-protected changes', async () => {
    const session = (await admin.getSession()) as { user: { email: string } };
    expect(session.user.email).toBe('root@example.com');
    const project = (await admin.createProject({ body: { key: 'shop', name: 'Shop' } })) as {
      environments: { key: string }[];
    };
    expect(project.environments.map((e) => e.key)).toContain('production');
  });

  it('works with a scoped API token, and maps errors to AdminApiError', async () => {
    const minted = (await admin.createApiToken({
      body: {
        name: 'ci',
        scopes: ['flags:read', 'flags:write'],
        project: 'shop',
        expiresInDays: 7,
      },
    })) as { id: string; secret: string };
    const ci = new AdminClient({ baseUrl, token: minted.secret });

    await ci.createFlag({
      path: { project: 'shop' },
      body: { key: 'new-checkout', name: 'New checkout', type: 'boolean' },
    });
    const listed = (await ci.listFlags({
      path: { project: 'shop' },
      query: { environment: 'production', q: 'checkout' },
    })) as { flags: { key: string }[] };
    expect(listed.flags.map((f) => f.key)).toEqual(['new-checkout']);
    const flag = (await ci.getFlag({ path: { project: 'shop', flag: 'new-checkout' } })) as {
      version: number;
    };
    await ci.setKillSwitch({
      path: { project: 'shop', flag: 'new-checkout', environment: 'production' },
      body: { enabled: true },
    });
    await ci.archiveFlag({
      path: { project: 'shop', flag: 'new-checkout' },
      body: { version: flag.version },
    });

    const invalid = await ci
      .createFlag({ path: { project: 'shop' }, body: { key: '-bad', name: 'x', type: 'boolean' } })
      .catch((e: unknown) => e);
    expect(invalid).toBeInstanceOf(AdminApiError);
    expect(invalid).toMatchObject({ status: 400, code: 'invalid_argument' });
    expect((invalid as AdminApiError).requestId).toMatch(/.+/);
    expect((invalid as AdminApiError).details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'key' })]),
    );

    await expect(ci.listWebhooks({ path: { project: 'shop' } })).rejects.toMatchObject({
      status: 403,
      code: 'permission_denied',
    });
    await expect(ci.listApiTokens()).rejects.toMatchObject({ status: 403 });

    await admin.revokeApiToken({ path: { id: minted.id } });
    await expect(ci.listProjects()).rejects.toMatchObject({
      status: 401,
      code: 'unauthenticated',
    });
  });

  it('fetches the document it was generated from without credentials', async () => {
    const anonymous = new AdminClient({ baseUrl });
    const doc = (await anonymous.getOpenApiDocument()) as { openapi: string };
    expect(doc.openapi).toBe('3.1.0');
    await expect(anonymous.listProjects()).rejects.toMatchObject({ status: 401 });
  });

  it('downloads an export and imports it under a new key', async () => {
    const exported = (await admin.exportProject({ path: { project: 'shop' } })) as {
      format: string;
      checksums?: unknown;
    };
    expect(exported.format).toBe('flagship.project');
    const imported = (await admin.importProject({
      query: { key: 'shop-copy', name: 'Shop copy' },
      body: exported as Parameters<AdminClient['importProject']>[0]['body'],
    })) as { project: { key: string }; flags: number };
    expect(imported).toMatchObject({ project: { key: 'shop-copy' }, flags: 1 });
  });

  it('signs out', async () => {
    const other = await AdminClient.login({ baseUrl }, 'root@example.com', PASSWORD);
    await other.signOut();
    await expect(other.getSession()).rejects.toMatchObject({ status: 401 });
  });
});
