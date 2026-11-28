import { CODE_REFERENCE_LIMITS } from '@flagship/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApp, type TestApp } from '../../test/app.js';
import { PASSWORD, signIn, userWithRole, type Client } from '../../test/session.js';

let t: TestApp;
let admin: Client;
let editor: Client;
let viewer: Client;

const P = '/api/projects/default';
const REFS = `${P}/code-references`;

beforeAll(async () => {
  t = await testApp({ bootstrapAdmin: { email: 'root@example.com', password: PASSWORD } });
  admin = await signIn(t.app.server, 'root@example.com');
  editor = await userWithRole(t.app.server, t.db, 'eddie@example.com', 'editor');
  viewer = await userWithRole(t.app.server, t.db, 'vera@example.com', 'viewer');
  for (const key of ['banner', 'checkout', 'old-promo']) {
    const res = await admin.request('POST', `${P}/flags`, { key, name: key, type: 'boolean' });
    expect(res.statusCode, res.body).toBe(201);
  }
  const archived = await admin.request('POST', `${P}/flags/old-promo/archive`, { version: 1 });
  expect(archived.statusCode, archived.body).toBe(200);
  const other = await admin.request('POST', '/api/projects', { key: 'other', name: 'Other' });
  expect(other.statusCode, other.body).toBe(201);
});
afterAll(() => t.close());

const hunk = (path: string, line: number, text = `if (flags.get('banner')) {`) => ({
  path,
  startLine: line,
  lines: [text],
  matchLines: [line],
});

function upload(branch: string, references: Record<string, unknown>, extra = {}) {
  return {
    repository: 'github.com/acme/shop',
    branch,
    commit: 'a'.repeat(40),
    urlTemplate: 'https://github.com/acme/shop/blob/{commit}/{path}#L{line}',
    filesScanned: 120,
    references,
    ...extra,
  };
}

describe('code references', () => {
  it('stores a branch, replaces it on the next upload and shows it per flag', async () => {
    const first = await editor.request(
      'PUT',
      REFS,
      upload('main', {
        banner: { count: 3, hunks: [hunk('src/a.ts', 4), hunk('src/b.ts', 9)] },
        checkout: { count: 1, hunks: [hunk('src/c.ts', 1, "'checkout'")] },
        'old-promo': { count: 1, hunks: [hunk('src/d.ts', 2, "'old-promo'")] },
      }),
    );
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({
      repository: 'github.com/acme/shop',
      branch: 'main',
      commit: 'a'.repeat(40),
      filesScanned: 120,
      uploadedBy: 'eddie',
      flags: 3,
      references: 5,
    });

    const feature = await editor.request(
      'PUT',
      REFS,
      upload('feature/new-banner', { banner: { count: 1, hunks: [hunk('src/new.ts', 7)] } }),
    );
    expect(feature.statusCode, feature.body).toBe(200);

    // The next scan of main no longer finds checkout: it disappears from main only.
    const second = await editor.request(
      'PUT',
      REFS,
      upload(
        'main',
        { banner: { count: 1, hunks: [hunk('src/a.ts', 5)] } },
        { commit: 'b'.repeat(7) },
      ),
    );
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json()).toMatchObject({ commit: 'bbbbbbb', flags: 1, references: 1 });

    const banner = await viewer.request('GET', `${P}/flags/banner/code-references`);
    expect(banner.statusCode, banner.body).toBe(200);
    const branches = banner.json().branches;
    expect(branches.map((b: { branch: string }) => b.branch)).toEqual([
      'main',
      'feature/new-banner',
    ]);
    expect(branches[0]).toEqual({
      repository: 'github.com/acme/shop',
      branch: 'main',
      commit: 'bbbbbbb',
      urlTemplate: 'https://github.com/acme/shop/blob/{commit}/{path}#L{line}',
      filesScanned: 120,
      scannedAt: expect.any(String),
      uploadedBy: 'eddie',
      count: 1,
      hunks: [hunk('src/a.ts', 5)],
    });

    const checkout = await viewer.request('GET', `${P}/flags/checkout/code-references`);
    expect(checkout.json()).toEqual({ branches: [] });
    // Archived flags keep their references, which is how you find code left behind.
    const promo = await viewer.request('GET', `${P}/flags/old-promo/code-references`);
    expect(promo.json().branches).toEqual([]);

    const list = await viewer.request('GET', REFS);
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().flagKeys).toEqual(['banner', 'checkout', 'old-promo']);
    expect(
      list
        .json()
        .branches.map((b: { branch: string; flags: number; references: number }) => [
          b.branch,
          b.flags,
          b.references,
        ]),
    ).toEqual([
      ['main', 1, 1],
      ['feature/new-banner', 1, 1],
    ]);
  });

  it('accepts an upload with no references and no commit, and archived flags', async () => {
    const res = await editor.request(
      'PUT',
      REFS,
      upload(
        'empty',
        {
          'old-promo': {
            count: 2,
            hunks: [{ path: 'x.go', startLine: 3, lines: [], matchLines: [3, 8] }],
          },
        },
        { commit: null, urlTemplate: null, repository: 'local' },
      ),
    );
    expect(res.statusCode, res.body).toBe(200);
    const promo = await viewer.request('GET', `${P}/flags/old-promo/code-references`);
    expect(promo.json().branches).toMatchObject([
      { repository: 'local', branch: 'empty', commit: null, urlTemplate: null, count: 2 },
    ]);
    const none = await editor.request('PUT', REFS, upload('empty', {}, { repository: 'local' }));
    expect(none.json()).toMatchObject({ flags: 0, references: 0 });
    const list = await viewer.request('GET', REFS);
    expect(list.json().branches).toContainEqual(
      expect.objectContaining({ repository: 'local', branch: 'empty', flags: 0, references: 0 }),
    );
  });

  it('refuses keys that name no flag, and changes nothing', async () => {
    const res = await editor.request(
      'PUT',
      REFS,
      upload('main', {
        banner: { count: 1, hunks: [] },
        ghost: { count: 1, hunks: [] },
        phantom: { count: 1, hunks: [] },
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({
      code: 'invalid_argument',
      message: 'no flags "ghost", "phantom" in project "default"',
      details: { unknownFlags: ['ghost', 'phantom'] },
    });
    const banner = await viewer.request('GET', `${P}/flags/banner/code-references`);
    expect(banner.json().branches[0].hunks).toEqual([hunk('src/a.ts', 5)]);
    // A flag in another project is unknown here.
    const other = await editor.request('PUT', '/api/projects/other/code-references', {
      ...upload('main', { banner: { count: 1, hunks: [] } }),
    });
    expect(other.json().error.message).toBe('no flag "banner" in project "other"');
  });

  it('validates hunks, paths, commits and templates', async () => {
    const bad = async (body: unknown) => {
      const res = await editor.request('PUT', REFS, body);
      expect(res.statusCode, res.body).toBe(400);
      return res.json().error.details.map((d: { path: string }) => d.path);
    };
    expect(
      await bad(upload('m', { banner: { count: 1, hunks: [hunk('/etc/passwd', 1)] } })),
    ).toEqual(['references.banner.hunks.0.path']);
    expect(
      await bad(upload('m', { banner: { count: 1, hunks: [hunk('a/../b', 1)] } })),
    ).toHaveLength(1);
    expect(await bad(upload('m', { banner: { count: 1, hunks: [hunk('a\\b', 1)] } }))).toHaveLength(
      1,
    );
    expect(
      await bad(
        upload('m', {
          banner: { count: 2, hunks: [{ path: 'a', startLine: 1, lines: ['x'], matchLines: [2] }] },
        }),
      ),
    ).toEqual(['references.banner.hunks.0.matchLines']);
    expect(
      await bad(
        upload('m', {
          banner: { count: 2, hunks: [{ path: 'a', startLine: 1, lines: [], matchLines: [3, 2] }] },
        }),
      ),
    ).toEqual(['references.banner.hunks.0.matchLines']);
    expect(
      await bad(upload('m', { banner: { count: 1, hunks: [hunk('a', 1), hunk('b', 2)] } })),
    ).toEqual(['references.banner']);
    expect(await bad(upload('m', {}, { commit: 'HEAD' }))).toEqual(['commit']);
    expect(await bad(upload('m', {}, { urlTemplate: 'javascript:alert(1)//{path}' }))).toEqual([
      'urlTemplate',
    ]);
    expect(await bad(upload('m\u0001x', {}, { repository: 'a\u0007' }))).toEqual([
      'repository',
      'branch',
    ]);
    const many = Array.from({ length: CODE_REFERENCE_LIMITS.hunksPerFlag + 1 }, (_, i) =>
      hunk('a', i + 1),
    );
    expect(await bad(upload('m', { banner: { count: 200, hunks: many } }))).toEqual([
      'references.banner.hunks',
    ]);
  });

  it('needs an editor to upload or delete, and a known project and flag', async () => {
    const denied = await viewer.request('PUT', REFS, upload('main', {}));
    expect(denied.statusCode).toBe(403);
    expect(
      (await viewer.request('DELETE', `${REFS}?repository=local&branch=empty`)).statusCode,
    ).toBe(403);
    expect((await viewer.request('GET', '/api/projects/nope/code-references')).statusCode).toBe(
      404,
    );
    const missing = await viewer.request('GET', `${P}/flags/nope/code-references`);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.message).toBe('flag "nope" not found');
  });

  it('deletes a branch, with its references', async () => {
    const q = (repository: string, branch: string) =>
      `${REFS}?repository=${encodeURIComponent(repository)}&branch=${encodeURIComponent(branch)}`;
    const res = await editor.request('DELETE', q('github.com/acme/shop', 'feature/new-banner'));
    expect(res.statusCode, res.body).toBe(204);
    const banner = await viewer.request('GET', `${P}/flags/banner/code-references`);
    expect(banner.json().branches.map((b: { branch: string }) => b.branch)).toEqual(['main']);
    const again = await editor.request('DELETE', q('github.com/acme/shop', 'feature/new-banner'));
    expect(again.statusCode).toBe(404);
    expect(again.json().error.message).toBe(
      'branch "feature/new-banner" of repository "github.com/acme/shop" not found',
    );
    expect((await editor.request('DELETE', REFS)).statusCode).toBe(400);
  });

  it('works with a token holding the code references scope, and keeps the branch limit', async () => {
    const minted = await editor.request('POST', '/api/tokens', {
      name: 'ci scan',
      scopes: ['flags:read', 'code-references:write'],
      project: 'default',
      expiresInDays: 7,
    });
    expect(minted.statusCode, minted.body).toBe(201);
    const secret = minted.json().secret as string;
    const send = (method: 'GET' | 'PUT', url: string, payload?: object) =>
      t.app.server.inject({
        method,
        url,
        headers: { authorization: `Bearer ${secret}` },
        ...(payload === undefined ? {} : { payload }),
      });
    expect((await send('GET', REFS)).statusCode).toBe(200);
    const put = await send('PUT', REFS, upload('ci', {}));
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json().uploadedBy).toBe('eddie (token ci scan)');

    const { count } = await t.db
      .selectFrom('code_reference_branches')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow();
    const project = await t.db
      .selectFrom('projects')
      .select('id')
      .where('key', '=', 'default')
      .executeTakeFirstOrThrow();
    const fill = CODE_REFERENCE_LIMITS.branchesPerProject - Number(count);
    await t.db
      .insertInto('code_reference_branches')
      .values(
        Array.from({ length: fill }, (_, i) => ({
          project_id: project.id,
          repository: 'filler',
          branch: `b${i}`,
          files_scanned: 0,
          uploaded_by: 'test',
        })),
      )
      .execute();
    const full = await send('PUT', REFS, upload('one-too-many', {}));
    expect(full.statusCode).toBe(409);
    expect(full.json().error).toMatchObject({ code: 'failed_precondition' });
    expect(full.json().error.message).toContain('delete merged branches first');
    // An existing branch can still be replaced.
    expect((await send('PUT', REFS, upload('ci', {}))).statusCode).toBe(200);
  });

  it('accepts uploads larger than the usual body limit', async () => {
    const line = 'x'.repeat(CODE_REFERENCE_LIMITS.lineLength);
    const hunks = Array.from({ length: CODE_REFERENCE_LIMITS.hunksPerFlag }, (_, i) => ({
      path: `src/file-${i}.ts`,
      startLine: 1,
      lines: Array.from({ length: 30 }, () => line),
      matchLines: [15],
    }));
    const body = upload('ci', { banner: { count: 100, hunks } });
    expect(JSON.stringify(body).length).toBeGreaterThan(1024 * 1024);
    const res = await editor.request('PUT', REFS, body);
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200);
  });
});
