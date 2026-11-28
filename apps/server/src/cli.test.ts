import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdminClient } from '@flagship/admin-client';
import { run, type Io } from '@flagship/cli';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApp, type TestApp } from '../test/app.js';
import { PASSWORD } from '../test/session.js';

let t: TestApp;
let server: string;
let root: AdminClient;
const dir = mkdtempSync(join(tmpdir(), 'flagship-cli-e2e-'));
const configFile = join(dir, 'home', 'config.json');

interface Ran {
  status: number;
  stdout: string;
  stderr: string;
  json: () => any;
}

/** Runs the CLI in-process against the real server, with its own config file. */
async function cli(argv: string[], opts: { stdin?: string; env?: Record<string, string> } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    readStdin: async () => opts.stdin ?? '',
    env: { FLAGSHIP_CONFIG: configFile, ...opts.env },
    cwd: dir,
  };
  const status = await run(argv, io);
  const r: Ran = {
    status,
    stdout: out.join('\n'),
    stderr: err.join('\n'),
    json: () => JSON.parse(out.join('\n')),
  };
  return r;
}

/** Runs it and insists on success, so a failure shows the CLI's own message. */
async function ok(argv: string[], opts: { stdin?: string; env?: Record<string, string> } = {}) {
  const r = await cli(argv, opts);
  expect(r.stderr, argv.join(' ')).toBe('');
  expect(r.status, argv.join(' ')).toBe(0);
  return r;
}

function write(name: string, value: unknown): string {
  writeFileSync(join(dir, name), JSON.stringify(value));
  return name;
}

beforeAll(async () => {
  t = await testApp({ bootstrapAdmin: { email: 'root@example.com', password: PASSWORD } });
  await t.app.server.listen({ host: '127.0.0.1', port: 0 });
  const { port } = t.app.server.server.address() as AddressInfo;
  server = `http://127.0.0.1:${port}`;
  root = await AdminClient.login({ baseUrl: server }, 'root@example.com', PASSWORD);
  await root.createProject({ body: { key: 'shop', name: 'Shop' } });
  await root.createUser({
    body: { email: 'ed@example.com', name: 'Ed', role: 'editor', password: PASSWORD },
  });
});
afterAll(() => t.close());

describe('the flagship CLI against the server', () => {
  it('signs in, saves a 0600 config, and manages profiles', async () => {
    const login = await ok(
      [
        'login',
        '--server',
        `${server}/api/`,
        '--email',
        'root@example.com',
        '--password-stdin',
        '-p',
        'shop',
        '-e',
        'development',
        '--json',
      ],
      { stdin: `${PASSWORD}\n` },
    );
    expect(login.json()).toEqual({
      name: 'default',
      current: true,
      server,
      project: 'shop',
      environment: 'development',
      auth: 'session',
      user: 'root@example.com',
    });
    if (process.platform !== 'win32') {
      expect(statSync(configFile).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, 'home')).mode & 0o777).toBe(0o700);
    }
    const saved = JSON.parse(readFileSync(configFile, 'utf8'));
    expect(saved.profiles.default.session.cookie).toMatch(/^flagship_session=/);

    const who = await ok(['whoami', '--json']);
    expect(who.json()).toMatchObject({ auth: 'session', user: { email: 'root@example.com' } });

    // A second profile for the editor, signed in with FLAGSHIP_PASSWORD.
    await ok(['login', '--profile', 'ed', '--server', server, '--email', 'ed@example.com'], {
      env: { FLAGSHIP_PASSWORD: PASSWORD },
    });
    await ok(['profile', 'set', '--profile', 'ed', '-p', 'shop', '-e', 'production']);
    const list = await ok(['profile', 'list']);
    expect(list.stdout.split('\n')).toEqual([
      expect.stringMatching(/^\s+PROFILE\s+SERVER\s+PROJECT\s+ENVIRONMENT\s+AUTH$/),
      expect.stringMatching(
        /^\*\s+default\s+http:\S+\s+shop\s+development\s+session \(root@example\.com\)$/,
      ),
      expect.stringMatching(/^\s+ed\s+http:\S+\s+shop\s+production\s+session \(ed@example\.com\)$/),
    ]);
    expect(list.stdout).not.toContain('flagship_session');

    await ok(['profile', 'use', 'ed']);
    expect((await ok(['whoami'])).stdout).toContain('Ed <ed@example.com>');
    await ok(['profile', 'use', 'default']);
    expect((await ok(['profile', 'show', 'ed'])).stdout).toContain('environment: production');
    expect((await cli(['profile', 'use', 'nobody'])).status).toBe(2);
    expect((await cli(['profile', 'set'])).stderr).toContain('pass --server, --project');
  });

  it('creates, lists, shows, edits, switches, archives and restores flags', async () => {
    await ok(['flag', 'create', 'new-checkout', '--name', 'New checkout', '--description', 'v2']);
    const variants = write('variants.json', [
      { key: 'blue', value: 'Blue' },
      { key: 'green', value: 'Green', name: 'Green one' },
    ]);
    const created = await ok([
      'flag',
      'create',
      'banner',
      '--type',
      'string',
      '--variants',
      `@${variants}`,
      '--client-side',
      '--json',
    ]);
    expect(created.json()).toMatchObject({ key: 'banner', type: 'string', clientSide: true });

    const table = await ok(['flag', 'list']);
    expect(table.stdout.split('\n')[0]).toMatch(
      /^KEY\s+STATUS\s+TYPE\s+RULES\s+STAGE\s+UPDATED\s+LAST EVALUATED$/,
    );
    expect(table.stdout).toMatch(/new-checkout\s+off\s+boolean\s+0\s+new/);
    // One flag per page, following the pages.
    const paged = await ok(['flag', 'list', '--limit', '1', '--all', '--json']);
    expect(paged.json().flags.map((f: { key: string }) => f.key)).toEqual([
      'banner',
      'new-checkout',
    ]);
    const one = await ok(['flag', 'list', '--limit', '1', '--json']);
    expect(one.json().flags).toHaveLength(1);
    const found = await ok(['flag', 'list', '--search', 'check', '--type', 'boolean', '--json']);
    expect(found.json().flags.map((f: { key: string }) => f.key)).toEqual(['new-checkout']);

    await ok(['flag', 'update', 'banner', '--name', 'Banner', '--server-only']);
    const got = await ok(['flag', 'get', 'banner', '--json']);
    expect(got.json()).toMatchObject({ name: 'Banner', clientSide: false, version: 2 });
    const stale = await cli(['flag', 'update', 'banner', '--name', 'Old', '--if-version', '1']);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain('flagship: flag "banner" was changed by someone else');
    expect((await cli(['flag', 'update', 'banner'])).stderr).toContain('nothing to change');

    // Targeting from a file: edit the JSON `flag get` printed and pass it back.
    const dev = got.json().environments.development;
    const targeting = write('banner-dev.json', {
      ...dev,
      enabled: true,
      rules: [
        {
          id: 'uk',
          clauses: [{ attribute: 'country', operator: 'in', values: ['gb', 'ie'] }],
          serve: { variant: 'green' },
        },
      ],
      fallthrough: {
        rollout: {
          variants: [
            { variant: 'blue', weight: 90_000 },
            { variant: 'green', weight: 10_000 },
          ],
        },
      },
    });
    const target = await ok(['flag', 'target', 'banner', '--file', targeting]);
    expect(target.stdout).toBe(
      [
        'Updated banner in development (now version 2):',
        '  on',
        '  rule uk: if country in "gb", "ie" then green',
        '  default: blue 90% / green 10%',
      ].join('\n'),
    );
    const again = await cli(['flag', 'target', 'banner', '--file', targeting, '--if-version', '1']);
    expect(again.status).toBe(1);
    const text = await ok(['flag', 'get', 'banner']);
    expect(text.stdout).toContain('  green = "Green" (Green one)');
    expect(text.stdout).toContain('development (version 2, updated');
    expect(text.stdout).toContain('production (version 1, updated');
    expect(text.stdout).toContain('  off (serves blue)');
    const onlyProd = await ok(['flag', 'get', 'banner', '-e', 'production']);
    expect(onlyProd.stdout).not.toContain('development (');
    expect((await cli(['flag', 'get', 'banner', '-e', 'qa'])).stderr).toContain(
      'has no environment "qa"; it has development, production',
    );

    await ok(['flag', 'on', 'new-checkout']);
    const keys = async (status: string) =>
      (await ok(['flag', 'list', '--status', status, '--json']))
        .json()
        .flags.map((f: { key: string }) => f.key);
    expect(await keys('on')).toEqual(['new-checkout']);
    expect(await keys('rollout')).toEqual(['banner']);
    await ok(['flag', 'off', 'new-checkout', '--reason', 'Paused for the café launch']);
    const audit = (await root.searchAudit({
      path: { project: 'shop' },
      query: { flag: 'new-checkout' },
    })) as { entries: { action: string; reason: string | null }[] };
    expect(audit.entries[0]).toMatchObject({
      action: 'flag.kill_switch',
      reason: 'Paused for the café launch',
    });

    await ok(['flag', 'archive', 'new-checkout']);
    expect(
      (await ok(['flag', 'list', '--status', 'archived', '--json'])).json().flags,
    ).toHaveLength(1);
    await ok(['flag', 'restore', 'new-checkout']);
    expect((await ok(['flag', 'get', 'new-checkout', '--json'])).json().archived).toBe(false);
  });

  it('manages segments and member lists', async () => {
    await ok([
      'segment',
      'create',
      'beta',
      '--name',
      'Beta',
      '--include',
      'alice,bob',
      '--include',
      'carol',
    ]);
    const moved = await ok([
      'segment',
      'update',
      'beta',
      '--exclude',
      'bob',
      '--unlist',
      'carol',
      '--json',
    ]);
    expect(moved.json()).toMatchObject({ included: ['alice'], excluded: ['bob'], version: 2 });
    const file = write('beta.json', {
      description: 'Early access',
      rules: [
        {
          id: 'staff',
          clauses: [{ attribute: 'email', operator: 'endsWith', values: ['@example.com'] }],
        },
      ],
      key: 'ignored',
    });
    await ok(['segment', 'update', 'beta', '--file', file]);
    const shown = await ok(['segment', 'get', 'beta']);
    expect(shown.stdout).toContain('description: Early access');
    expect(shown.stdout).toContain('included:    1: alice');
    expect(shown.stdout).toContain('  staff: email endsWith "@example.com"');
    expect((await ok(['segment', 'list'])).stdout).toMatch(/beta\s+Beta\s+1\s+1\s+1\s+3/);
    expect(
      (await cli(['segment', 'update', 'beta', '--include', 'x', '--exclude', 'x'])).stderr,
    ).toContain("can't both include and exclude x");
    await ok(['segment', 'create', 'temp']);
    await ok(['segment', 'delete', 'temp']);
    expect(
      (await ok(['segment', 'list', '--json'])).json().segments.map((s: { key: string }) => s.key),
    ).toEqual(['beta']);
  });

  it('evaluates with a trace from the live ruleset', async () => {
    const uk = await ok(['eval', 'banner', '--key', 'u1', '--attr', 'country=gb']);
    expect(uk.stdout.split('\n')[0]).toBe(
      'banner = "Green" (variant green, TARGETING_MATCH by rule uk)',
    );
    expect(uk.stdout).toContain('in shop/development for {"country":"gb","key":"u1"}');
    expect(uk.stdout).toContain('      yes  country in "gb", "ie"');
    const all = await ok(['eval', '--all', '--key', 'u1', '--json']);
    expect(Object.keys(all.json().results).sort()).toEqual(['banner', 'new-checkout']);
    const missing = await cli(['eval', 'nope', '--key', 'u1']);
    expect(missing.status).toBe(1);
  });

  it('runs change requests end to end on a protected environment', async () => {
    await root.setRequiredApprovals({
      path: { project: 'shop', environment: 'production' },
      body: { requiredApprovals: 1 },
    });
    const prod = (await ok(['flag', 'get', 'banner', '--json'])).json().environments.production;
    const proposal = write('banner-prod.json', { ...prod, enabled: true });

    // A direct edit is refused there; the editor proposes instead.
    const direct = await cli(['flag', 'target', 'banner', '-e', 'production', '--file', proposal]);
    expect(direct.status).toBe(1);
    expect(direct.stderr).toContain('flagship:');
    const proposed = await ok([
      'cr',
      'propose',
      'flag',
      'banner',
      '--profile',
      'ed',
      '--title',
      'Turn the banner on',
      '--file',
      proposal,
      '--json',
    ]);
    const id = proposed.json().id as string;
    expect(proposed.json()).toMatchObject({ status: 'open', revision: 1, canApply: false });

    expect((await cli(['cr', 'approve', id, '--profile', 'ed'])).status).toBe(1);
    expect((await cli(['cr', 'comment', id])).stderr).toContain('pass --comment TEXT');
    await ok(['cr', 'comment', id, '--comment', 'Looks fine']);
    const approved = await ok(['cr', 'approve', id, '--comment', 'Ship it']);
    expect(approved.stdout).toContain(`Approved revision 1 of ${id}.`);
    expect(approved.stdout).toContain('approvals: 1/1; approved by Admin');

    const listed = await ok(['cr', 'list', '--status', 'open']);
    expect(listed.stdout).toMatch(new RegExp(`${id}\\s+open\\s+flag banner\\s+production\\s+1/1`));
    const shown = await ok(['change-request', 'get', id]);
    expect(shown.stdout).toContain('  ~ enabled: false -> true');
    expect(shown.stdout).toContain('Ship it');
    expect(shown.stdout).toContain('can apply: yes');

    const applied = await ok(['cr', 'apply', id, '--profile', 'ed', '--json']);
    expect(applied.json().status).toBe('applied');
    expect(
      (await ok(['flag', 'get', 'banner', '-e', 'production', '--json'])).json().environments
        .production.enabled,
    ).toBe(true);

    // A segment proposal, asked to change, then closed with a reason.
    const seg = await ok([
      'cr',
      'propose',
      'segment',
      'vip',
      '--profile',
      'ed',
      '--title',
      'Add a VIP segment',
      '--include',
      'v1',
      '--json',
    ]);
    const segId = seg.json().id as string;
    await ok(['cr', 'request-changes', segId, '--comment', 'Name it properly']);
    expect((await ok(['cr', 'get', segId, '--json'])).json().approvals.changesRequestedBy).toEqual([
      'Admin',
    ]);
    const closed = await ok([
      'cr',
      'close',
      segId,
      '--profile',
      'ed',
      '--reason',
      'Not needed',
      '--json',
    ]);
    expect(closed.json()).toMatchObject({ status: 'closed' });
    expect(
      (await cli(['cr', 'propose', 'segment', 'vip', '--title', 'x', '--delete'])).stderr,
    ).toContain("doesn't exist in development");
    expect((await cli(['cr', 'propose', 'thing', 'x', '--title', 'x'])).stderr).toContain(
      'propose takes "flag" or "segment"',
    );

    // A stale proposal is rebased onto the live version.
    const off = write('banner-off.json', { ...prod, enabled: false });
    const stale = await ok([
      'cr',
      'propose',
      'flag',
      'banner',
      '-e',
      'production',
      '--title',
      'Off again',
      '--file',
      off,
      '--json',
    ]);
    const staleId = stale.json().id as string;
    await ok(['flag', 'off', 'banner', '-e', 'production']);
    await ok(['flag', 'on', 'banner', '-e', 'production']);
    expect((await ok(['cr', 'get', staleId])).stdout).toContain('moved on to version');
    const rebased = await ok(['cr', 'rebase', staleId, '--json']);
    expect(rebased.json()).toMatchObject({ revision: 2 });

    await root.setRequiredApprovals({
      path: { project: 'shop', environment: 'production' },
      body: { requiredApprovals: 0 },
    });
  });

  it('exports the project', async () => {
    const r = await ok(['export', '--out', 'shop.json']);
    expect(r.stdout).toBe('Exported shop to shop.json: 2 flags and 1 segments in 2 environments.');
    const doc = JSON.parse(readFileSync(join(dir, 'shop.json'), 'utf8'));
    expect(doc).toMatchObject({ format: 'flagship.project', project: { key: 'shop' } });
    expect((await ok(['export', '--json'])).json().flags).toHaveLength(2);
  });

  it('scans a repository with a scoped token and shows the references', async () => {
    const minted = (await root.createApiToken({
      body: {
        name: 'scan',
        scopes: ['flags:read', 'code-references:write'],
        project: 'shop',
        expiresInDays: 1,
      },
    })) as { secret: string };
    const env = {
      FLAGSHIP_SERVER: server,
      FLAGSHIP_TOKEN: minted.secret,
      FLAGSHIP_PROJECT: 'shop',
    };
    const repo = join(dir, 'repo');
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(join(repo, 'vendor'), { recursive: true });
    writeFileSync(join(repo, '.gitignore'), 'vendor/\n');
    writeFileSync(join(repo, 'src', 'app.ts'), "if (flags.get('new-checkout')) {}\n");
    writeFileSync(join(repo, 'vendor', 'lib.js'), "'new-checkout'");
    const scanned = await ok(
      ['scan', 'repo', '--repository', 'acme/shop', '--branch', 'main', '--json'],
      { env },
    );
    expect(scanned.json()).toMatchObject({ uploaded: true, filesScanned: 2 });
    const refs = await ok(['refs', 'get', 'new-checkout', '--json'], { env });
    expect(refs.json().branches).toMatchObject([
      {
        repository: 'acme/shop',
        branch: 'main',
        uploadedBy: 'Admin (token scan)',
        count: 1,
        hunks: [{ path: 'src/app.ts', matchLines: [1] }],
      },
    ]);
    const list = await ok(['refs', 'list'], { env });
    expect(list.stdout).toContain('acme/shop   main');
    await ok(['refs', 'delete', '--repository', 'acme/shop', '--branch', 'main'], { env });
    expect((await ok(['refs', 'get', 'new-checkout'], { env })).stdout).toBe(
      'No code references to new-checkout.',
    );
  });

  it('generates typed accessors with a read-only token and catches a new flag with --check', async () => {
    const minted = (await root.createApiToken({
      body: { name: 'codegen', scopes: ['flags:read'], project: 'shop', expiresInDays: 1 },
    })) as { secret: string };
    const env = {
      FLAGSHIP_SERVER: server,
      FLAGSHIP_TOKEN: minted.secret,
      FLAGSHIP_PROJECT: 'shop',
      FLAGSHIP_ENVIRONMENT: 'production',
    };
    const wrote = await ok(['codegen', '--out', 'gen/flags.ts'], { env });
    expect(wrote.stdout).toMatch(/^Wrote \d+ flag accessors for TypeScript to gen\/flags\.ts\.$/);
    const code = readFileSync(join(dir, 'gen', 'flags.ts'), 'utf8');
    expect(code).toContain('// Generated by flagship codegen from project "shop".');
    expect(code).toContain('  "new-checkout": ');
    await ok(['codegen', '--out', 'gen/flags.go'], { env });
    expect(readFileSync(join(dir, 'gen', 'flags.go'), 'utf8')).toContain(
      'KeyNewCheckout = "new-checkout"',
    );
    expect((await ok(['codegen', '--out', 'gen/flags.ts', '--check'], { env })).stdout).toMatch(
      /^gen\/flags\.ts is up to date/,
    );
    await root.createFlag({
      path: { project: 'shop' },
      body: { key: 'codegen-new', name: 'Codegen new', type: 'boolean' },
    });
    const stale = await cli(['codegen', '--out', 'gen/flags.ts', '--check', '--json'], { env });
    expect(stale.status).toBe(3);
    expect(stale.json()).toMatchObject({ upToDate: false, file: 'gen/flags.ts' });
    await root.archiveFlag({
      path: { project: 'shop', flag: 'codegen-new' },
      body: { version: 1 },
    });
    expect((await cli(['codegen', '--out', 'gen/flags.ts', '--check'], { env })).status).toBe(0);
  });

  it('works with an API token from the environment, without a profile', async () => {
    const minted = (await root.createApiToken({
      body: { name: 'ci', scopes: ['flags:read'], project: 'shop', expiresInDays: 1 },
    })) as { id: string; secret: string };
    const env = {
      FLAGSHIP_TOKEN: minted.secret,
      FLAGSHIP_SERVER: server,
      FLAGSHIP_PROJECT: 'shop',
    };
    const r = await cli(['flag', 'list', '-e', 'production', '--profile', 'none', '--json'], {
      env,
    });
    expect(r.status).toBe(0);
    expect(r.json().flags).toHaveLength(2);
    // The token can't write, and the error says so.
    const denied = await cli(['flag', 'on', 'banner', '-e', 'production', '--profile', 'none'], {
      env,
    });
    expect(denied.status).toBe(1);
    expect(denied.stderr).toContain('flagship:');

    await ok(['login', '--profile', 'ci', '--server', server, '--token-stdin'], {
      stdin: minted.secret,
    });
    await root.revokeApiToken({ path: { id: minted.id } });
    const revoked = await cli([
      'flag',
      'list',
      '--profile',
      'ci',
      '-p',
      'shop',
      '-e',
      'production',
    ]);
    expect(revoked.status).toBe(1);
    expect(revoked.stderr).toContain('the token for profile "ci" was refused');
    await ok(['profile', 'remove', 'ci']);
  });

  it('logs out, ending the session on the server', async () => {
    const before = JSON.parse(readFileSync(configFile, 'utf8')).profiles.ed.session;
    const out = await ok(['logout', '--profile', 'ed', '--json']);
    expect(out.json()).toEqual({ profile: 'ed', signedOut: true, sessionEnded: true });
    const stolen = new AdminClient({ baseUrl: server, session: before });
    await expect(stolen.getSession()).rejects.toMatchObject({ status: 401 });
    expect((await cli(['whoami', '--profile', 'ed'])).stderr).toContain('is not signed in');
  });

  it('refuses a config file other users can read', async () => {
    if (process.platform === 'win32') return;
    chmodSync(configFile, 0o644);
    const r = await cli(['whoami']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('run: chmod 600');
    chmodSync(configFile, 0o600);
    await ok(['whoami']);
  });
});
