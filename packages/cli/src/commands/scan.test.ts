import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { apiError, fakeServer, json } from '../../test/fake-server.js';
import { harness } from '../../test/memory-io.js';
import { defaultUrlTemplate, repositoryName } from './scan.js';

const BRANCH = {
  repository: 'github.com/acme/shop',
  branch: 'main',
  commit: 'c'.repeat(40),
  urlTemplate: 'https://github.com/acme/shop/blob/{commit}/{path}#L{line}',
  filesScanned: 3,
  scannedAt: '2026-11-28T10:00:00.000Z',
  uploadedBy: 'ci',
};

function setup(env: Record<string, string> = {}) {
  const server = fakeServer({
    'GET /api/projects/shop/code-references': () =>
      json({
        flagKeys: ['banner', 'new-checkout', 'unused'],
        branches: [{ ...BRANCH, flags: 2, references: 3 }],
      }),
    'PUT /api/projects/shop/code-references': (req) => {
      const body = req.body as { references: Record<string, { count: number }> };
      const refs = Object.values(body.references);
      return json({
        ...BRANCH,
        ...(req.body as object),
        scannedAt: BRANCH.scannedAt,
        uploadedBy: 'ci',
        flags: refs.length,
        references: refs.reduce((n, r) => n + r.count, 0),
      });
    },
    'DELETE /api/projects/shop/code-references': (req) =>
      req.query.get('branch') === 'gone'
        ? apiError(404, 'not_found', 'branch "gone" of repository "r" not found')
        : new Response(null, { status: 204 }),
    'GET /api/projects/shop/flags/banner/code-references': () =>
      json({
        branches: [
          {
            ...BRANCH,
            count: 2,
            hunks: [
              {
                path: 'src/app.ts',
                startLine: 3,
                lines: ['', "if (flags.get('banner')) {", '  show();'],
                matchLines: [4],
              },
              { path: 'go/main.go', startLine: 9, lines: [], matchLines: [9] },
            ],
          },
          {
            ...BRANCH,
            branch: 'feature/x',
            commit: null,
            urlTemplate: null,
            count: 1,
            hunks: [{ path: 'a b.ts', startLine: 1, lines: ["'banner'"], matchLines: [1] }],
          },
        ],
      }),
  });
  const h = harness({
    fetch: server.fetch,
    env: {
      FLAGSHIP_TOKEN: 'fst_t',
      FLAGSHIP_SERVER: 'http://flags.test',
      FLAGSHIP_PROJECT: 'shop',
      ...env,
    },
  });
  return { ...h, server };
}

function write(root: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();

function repo(root: string) {
  write(root, {
    '.gitignore': 'build/\n',
    'src/app.ts': "import x from 'y';\nif (flags.get('banner')) {\n  show('new-checkout');\n}\n",
    'src/more.ts': "flags.get('banner')\n",
    'build/out.js': "'banner'",
  });
  git(root, 'init', '-q', '-b', 'trunk');
  git(root, 'remote', 'add', 'origin', 'https://bot:secret@github.com/acme/shop.git');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  return git(root, 'rev-parse', 'HEAD');
}

describe('flagship scan', () => {
  it('scans a git checkout and uploads the branch, commit and a link template', async () => {
    const h = setup();
    const root = join(h.dir, 'shop');
    const sha = repo(root);
    const r = await h.cli(['scan', 'shop', '--context', '1']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const put = h.server.seen.find((s) => s.method === 'PUT')!;
    expect(put.body).toEqual({
      repository: 'github.com/acme/shop',
      branch: 'trunk',
      commit: sha,
      urlTemplate: 'https://github.com/acme/shop/blob/{commit}/{path}#L{line}',
      filesScanned: 3,
      references: {
        banner: {
          count: 2,
          hunks: [
            {
              path: 'src/app.ts',
              startLine: 1,
              lines: [
                "import x from 'y';",
                "if (flags.get('banner')) {",
                "  show('new-checkout');",
              ],
              matchLines: [2],
            },
            {
              path: 'src/more.ts',
              startLine: 1,
              lines: ["flags.get('banner')", ''],
              matchLines: [1],
            },
          ],
        },
        'new-checkout': {
          count: 1,
          hunks: [
            {
              path: 'src/app.ts',
              startLine: 2,
              lines: ["if (flags.get('banner')) {", "  show('new-checkout');", '}'],
              matchLines: [3],
            },
          ],
        },
      },
    });
    expect(r.stdout).toMatch(
      /^Scanned 3 files in \d+\.\d s on 1 thread: 3 references to 2 of 3 flags\.\n\nFLAG {10}REFERENCES {2}FILES\nbanner {8}2 {11}2\nnew-checkout {2}1 {11}1\n\nUploaded github\.com\/acme\/shop trunk @ [0-9a-f]{12} to shop\.$/,
    );
  });

  it('prefers the GitHub Actions environment, and options over both', async () => {
    const h = setup({
      GITHUB_REPOSITORY: 'acme/web',
      GITHUB_SERVER_URL: 'https://github.example.com',
      GITHUB_HEAD_REF: 'feature/login',
      GITHUB_REF_NAME: '12/merge',
      GITHUB_REF_TYPE: 'branch',
      GITHUB_SHA: 'd'.repeat(40),
    });
    write(h.dir, { 'a.ts': "'banner'", 'bin.png': '\u0000' });
    const r = await h.cli(['scan', '--json']);
    expect(r.stderr).toBe('');
    expect(r.json()).toMatchObject({
      project: 'shop',
      repository: 'github.example.com/acme/web',
      branch: 'feature/login',
      // Not a git checkout, so the commit comes from GITHUB_SHA.
      commit: 'd'.repeat(40),
      urlTemplate: null,
      uploaded: true,
      filesScanned: 1,
      filesSkipped: 1,
      workers: 1,
      hunksDropped: 0,
      references: { banner: { count: 1 } },
    });

    const push = setup({ GITHUB_REF_NAME: 'release', GITHUB_REF_TYPE: 'branch' });
    write(push.dir, { 'a.ts': "'banner'" });
    const p = await push.cli([
      'scan',
      '--repository',
      'gitlab.com/acme/api',
      '--commit',
      'abcdef1',
      '--no-source',
      '--exclude',
      '*.ts',
      '--json',
    ]);
    expect(p.json()).toMatchObject({
      repository: 'gitlab.com/acme/api',
      branch: 'release',
      commit: 'abcdef1',
      urlTemplate: 'https://gitlab.com/acme/api/-/blob/{commit}/{path}#L{line}',
      filesScanned: 0,
      references: {},
    });
  });

  it('prints without uploading on a dry run, and skips large files', async () => {
    const h = setup();
    write(h.dir, { 'a.ts': "'banner'", 'big.ts': `'unused'${' '.repeat(100)}` });
    const r = await h.cli([
      'scan',
      '--branch',
      'local',
      '--url-template',
      '',
      '--dry-run',
      '--max-file-size',
      '50',
      '--workers',
      '2',
    ]);
    expect(r.status).toBe(0);
    expect(h.server.seen.map((s) => s.method)).toEqual(['GET']);
    expect(r.stdout).toContain('Skipped 1 file: binary, unreadable or over the size limit.');
    expect(r.stdout).toMatch(/Dry run: nothing uploaded for .+ local\.$/);
  });

  it('refuses a detached checkout without --branch, and bad options', async () => {
    const h = setup();
    const root = join(h.dir, 'shop');
    const sha = repo(root);
    git(root, 'checkout', '-q', '--detach');
    const detached = await h.cli(['scan', 'shop']);
    expect(detached.status).toBe(2);
    expect(detached.stderr).toContain('pass --branch NAME');
    const ok = await h.cli(['scan', 'shop', '--branch', 'trunk', '--json']);
    expect(ok.json().commit).toBe(sha);

    const commit = await h.cli(['scan', '--branch', 'b', '--commit', 'HEAD']);
    expect(commit.status).toBe(2);
    expect(commit.stderr).toContain('--commit must be a hexadecimal commit id, not "HEAD"');
    const url = await h.cli(['scan', '--branch', 'b', '--url-template', 'ftp://x/{path}']);
    expect(url.status).toBe(2);
    expect(url.stderr).toContain('--url-template must be an http or https URL');
    const context = await h.cli(['scan', '--branch', 'b', '--context', '9']);
    expect(context.status).toBe(2);
    expect(context.stderr).toContain('--context must be from 0 to 5');
  });

  it('passes on the server refusing an upload', async () => {
    const h = setup();
    h.server.seen.length = 0;
    const refuse = fakeServer({
      'GET /api/projects/shop/code-references': () => json({ flagKeys: ['banner'], branches: [] }),
      'PUT /api/projects/shop/code-references': () =>
        apiError(409, 'failed_precondition', 'too many branches; delete merged branches first'),
    });
    const r = await harness({ fetch: refuse.fetch, env: h.env }).cli(['scan', '--branch', 'x']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('delete merged branches first');
  });
});

describe('flagship refs', () => {
  it('lists branches', async () => {
    const h = setup();
    const r = await h.cli(['refs', 'list']);
    expect(r.stdout).toBe(
      [
        'REPOSITORY            BRANCH  COMMIT        FLAGS  REFERENCES  SCANNED',
        'github.com/acme/shop  main    cccccccccccc  2      3           2026-11-28 10:00',
      ].join('\n'),
    );
    const none = fakeServer({
      'GET /api/projects/shop/code-references': () => json({ flagKeys: [], branches: [] }),
    });
    const empty = await harness({ fetch: none.fetch, env: h.env }).cli(['refs', 'list']);
    expect(empty.stdout).toBe('No code references in shop: run flagship scan in a repository.');
  });

  it('shows where a flag is used, with links', async () => {
    const h = setup();
    const r = await h.cli(['refs', 'get', 'banner']);
    expect(r.stdout).toBe(
      [
        `github.com/acme/shop main @ cccccccccccc: 2 references in 2 files, scanned 2026-11-28 10:00`,
        "  src/app.ts:4  if (flags.get('banner')) {",
        `    https://github.com/acme/shop/blob/${'c'.repeat(40)}/src/app.ts#L4`,
        '  go/main.go:9',
        `    https://github.com/acme/shop/blob/${'c'.repeat(40)}/go/main.go#L9`,
        'github.com/acme/shop feature/x: 1 reference in 1 file, scanned 2026-11-28 10:00',
        "  a b.ts:1  'banner'",
      ].join('\n'),
    );
    const only = await h.cli(['refs', 'get', 'banner', '--branch', 'feature/x', '--json']);
    expect(only.json().branches.map((b: { branch: string }) => b.branch)).toEqual(['feature/x']);
    const missing = await h.cli(['refs', 'get', 'banner', '--branch', 'nope']);
    expect(missing.stdout).toBe('No code references to banner on nope.');
  });

  it('deletes a branch', async () => {
    const h = setup();
    const r = await h.cli(['refs', 'delete', '--repository', 'r', '--branch', 'feature/x']);
    expect(r.stdout).toBe('Deleted the code references of r feature/x.');
    const del = h.server.seen.find((s) => s.method === 'DELETE')!;
    expect(Object.fromEntries(del.query)).toEqual({ repository: 'r', branch: 'feature/x' });
    expect((await h.cli(['refs', 'delete', '--branch', 'x'])).status).toBe(2);
    const gone = await h.cli(['refs', 'delete', '--repository', 'r', '--branch', 'gone']);
    expect(gone.status).toBe(1);
  });
});

describe('repository names', () => {
  it('normalizes remotes without credentials', () => {
    expect(repositoryName('git@github.com:acme/shop.git')).toBe('github.com/acme/shop');
    expect(repositoryName('https://bot:t0k@GitHub.com/acme/shop.git')).toBe('github.com/acme/shop');
    expect(repositoryName('ssh://git@gitlab.com:2222/group/sub/proj.git')).toBe(
      'gitlab.com/group/sub/proj',
    );
    expect(repositoryName('https://host.example/')).toBeUndefined();
    expect(repositoryName('/srv/git/shop.git')).toBeUndefined();
    expect(repositoryName('file:///srv/git/shop.git')).toBeUndefined();
  });

  it('links to lines on the hosts it knows', () => {
    expect(defaultUrlTemplate('bitbucket.org/a/b')).toBe(
      'https://bitbucket.org/a/b/src/{commit}/{path}#lines-{line}',
    );
    expect(defaultUrlTemplate('git.internal/a/b')).toBeNull();
  });
});
