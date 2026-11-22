import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { apiError, fakeServer, json } from '../test/fake-server.js';
import { harness } from '../test/memory-io.js';
import { normalizeServer } from './command.js';
import { COMMANDS } from './commands/index.js';
import { VERSION } from './run.js';

const SERVER = 'http://flags.test';

describe('help', () => {
  it('lists every command at the top level', async () => {
    const { cli } = harness();
    for (const argv of [[], ['help'], ['--help']]) {
      const r = await cli(argv);
      expect(r.status).toBe(0);
      for (const c of COMMANDS) expect(r.stdout).toContain(c.path.join(' '));
    }
  });

  it('shows one group, and exits 2 when a group is given without a command', async () => {
    const { cli } = harness();
    const r = await cli(['flag', '--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage: flagship flag <command>');
    expect(r.stdout).toContain('flag target <key>');
    expect(r.stdout).not.toContain('segment list');
    const bare = await cli(['segment']);
    expect(bare.status).toBe(2);
    expect(bare.stdout).toContain('segment delete');
    expect((await cli(['help', 'cr'])).stdout).toContain('change-request approve');
  });

  it("shows a command's options, global options and details", async () => {
    const { cli } = harness();
    for (const argv of [
      ['flag', 'list', '--help'],
      ['help', 'flag', 'list'],
      ['-h', 'flag', 'list'],
    ]) {
      const r = await cli(argv);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('Usage: flagship flag list [options]');
      expect(r.stdout).toMatch(/--status STATUS\s+on, off, rollout or archived/);
      expect(r.stdout).toMatch(/-e, --environment KEY/);
    }
    const segment = await cli(['segment', 'create', '--help']);
    expect(segment.stdout).toMatch(/--include KEYS \.\.\./);
    expect((await cli(['login', '--help'])).stdout).toContain('mode 0600');
  });

  it('prints the version', async () => {
    const { cli } = harness();
    expect((await cli(['--version'])).stdout).toBe(VERSION);
    expect((await cli(['--version', '--json'])).json()).toEqual({ version: VERSION });
  });
});

describe('usage errors', () => {
  it('exits 2 with a pointer to help', async () => {
    const { cli } = harness();
    const cases: [string[], string][] = [
      [['nope'], 'unknown command "nope"'],
      [['flag', 'nope'], 'unknown command "flag nope"'],
      [['flag', 'list', '--bogus'], "Unknown option '--bogus'"],
      [['flag', 'get'], 'flagship flag get takes <key>'],
      [['flag', 'get', 'a', 'b'], 'takes <key>, not "b"'],
      [['whoami', 'x'], 'takes no arguments, not "x"'],
      [['--name', 'x', 'flag', 'create', 'k'], 'unknown command "x flag"'],
      [['whoami'], 'no server for profile "default"'],
      [['profile', 'show'], 'no profile "default"'],
    ];
    for (const [argv, message] of cases) {
      const r = await cli(argv);
      expect(r.status, argv.join(' ')).toBe(2);
      expect(r.stderr, argv.join(' ')).toContain(message);
      expect(r.stderr).toContain('Run flagship --help for usage.');
    }
  });

  it('writes errors as JSON with --json', async () => {
    const { cli } = harness();
    const r = await cli(['flag', 'get', '--json']);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(JSON.parse(r.stderr)).toEqual({
      error: { code: 'usage', message: 'flagship flag get takes <key>' },
    });
  });

  it('needs a project, an environment and credentials', async () => {
    const { cli } = harness();
    expect(
      (await cli(['flag', 'list', '--server', SERVER, '-p', 'a', '-e', 'b'])).stderr,
    ).toContain('not signed in: run flagship login');
    const { cli: withToken } = harness({
      env: { FLAGSHIP_TOKEN: 'fst_x', FLAGSHIP_SERVER: SERVER },
    });
    expect((await withToken(['flag', 'list'])).stderr).toContain('no project');
    expect((await withToken(['flag', 'list', '-p', 'shop'])).stderr).toContain('no environment');
  });

  it('refuses servers that are not plain http(s) origins', () => {
    expect(normalizeServer('https://flags.example.com/')).toBe('https://flags.example.com');
    expect(normalizeServer('http://localhost:8080/api/')).toBe('http://localhost:8080');
    expect(normalizeServer('https://example.com/flags/api')).toBe('https://example.com/flags');
    expect(() => normalizeServer('flags.example.com')).toThrow('is not a URL');
    expect(() => normalizeServer('ftp://x')).toThrow('must use http or https');
    expect(() => normalizeServer('https://u:p@x')).toThrow('must not carry credentials');
    expect(() => normalizeServer('https://x/?a=1')).toThrow('must not carry credentials');
  });
});

describe('talking to the server', () => {
  const env = { FLAGSHIP_TOKEN: 'fst_t', FLAGSHIP_SERVER: SERVER, FLAGSHIP_PROJECT: 'shop' };

  it('sends the token, the reason (percent-encoded) and the link, and prints JSON', async () => {
    const server = fakeServer({
      'POST /api/projects/shop/flags/f/environments/production/kill-switch': () =>
        json({ key: 'f', environments: {} }),
    });
    const { cli } = harness({ fetch: server.fetch, env });
    const r = await cli([
      'flag',
      'off',
      'f',
      '-e',
      'production',
      '--reason',
      'Incident 42: café checkout errors',
      '--link',
      'https://tickets.example.com/42',
      '--json',
    ]);
    expect(r.status).toBe(0);
    expect(r.json()).toEqual({ key: 'f', environments: {} });
    const [req] = server.seen;
    expect(req?.headers.get('authorization')).toBe('Bearer fst_t');
    expect(req?.headers.get('flagship-reason')).toBe(
      encodeURIComponent('Incident 42: café checkout errors'),
    );
    expect(req?.headers.get('flagship-link')).toBe('https://tickets.example.com/42');
    expect(req?.headers.get('user-agent')).toBe('flagship-cli');
    expect(req?.body).toEqual({ enabled: false });
  });

  it('shows the server’s error, its field details and request id, and exits 1', async () => {
    const server = fakeServer({
      'POST /api/projects/shop/flags': () =>
        apiError(400, 'invalid_argument', 'the flag is not valid', [
          { path: 'key', message: 'must start with a letter or digit' },
          { path: '', message: 'and something about the whole' },
          'not an issue',
        ]),
    });
    const { cli } = harness({ fetch: server.fetch, env });
    const r = await cli(['flag', 'create', 'x_']);
    expect(r.status).toBe(1);
    expect(r.stderr).toBe(
      [
        'flagship: the flag is not valid',
        '  key: must start with a letter or digit',
        '  and something about the whole',
        '  request id: req-1',
      ].join('\n'),
    );
    const j = await cli(['flag', 'create', 'x_', '--json']);
    expect(JSON.parse(j.stderr)).toEqual({
      error: {
        code: 'invalid_argument',
        message: 'the flag is not valid',
        status: 400,
        requestId: 'req-1',
        details: expect.any(Array),
      },
    });
  });

  it('turns a refused credential into advice to sign in again', async () => {
    const server = fakeServer({
      'GET /api/projects/shop/flags/f': () => apiError(401, 'unauthenticated', 'token expired'),
    });
    const { cli } = harness({ fetch: server.fetch, env });
    const r = await cli(['flag', 'get', 'f']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      'the token for profile "default" was refused (token expired): run flagship login again',
    );
  });

  it('reports failures that are not API errors', async () => {
    const fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof globalThis.fetch;
    const { cli } = harness({ fetch, env });
    const r = await cli(['flag', 'get', 'f', '--json']);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stderr)).toEqual({ error: { code: 'internal', message: 'fetch failed' } });
  });

  it('accepts cr for change-request', async () => {
    const server = fakeServer({
      'GET /api/projects/shop/change-requests': () => json({ changeRequests: [], next: null }),
    });
    const { cli } = harness({ fetch: server.fetch, env });
    const r = await cli(['--json', 'cr', 'list', '--status', 'open']);
    expect(r.status).toBe(0);
    expect(r.json()).toEqual({ changeRequests: [] });
    expect(server.seen[0]?.query.get('status')).toBe('open');
    expect(server.seen[0]?.query.has('environment')).toBe(false);
    expect((await cli(['cr', 'list', '--status', 'merged'])).stderr).toContain(
      '--status must be one of open, applied, closed, not "merged"',
    );
    expect((await cli(['cr', 'list', '--limit', 'ten'])).stderr).toContain(
      '--limit must be a whole number, not "ten"',
    );
    expect((await cli(['cr', 'list', '--limit', '0'])).stderr).toContain(
      '--limit must be from 1 to 200',
    );
  });
});

describe('login', () => {
  function sessionServer(password: string) {
    return fakeServer({
      'POST /api/session': (req) =>
        (req.body as { password: string }).password === password
          ? new Response(JSON.stringify({ csrfToken: 'csrf-1', user: {} }), {
              headers: {
                'content-type': 'application/json',
                'set-cookie': 'flagship_session=s3cret; Path=/; HttpOnly',
              },
            })
          : apiError(401, 'unauthenticated', 'email or password is incorrect'),
      'GET /api/session': () =>
        json({ user: { id: 'u1', email: 'a@example.com', name: 'Ann', role: 'admin' } }),
      'DELETE /api/session': () => new Response(null, { status: 204 }),
    });
  }

  it('prompts for a password in a terminal and saves the session', async () => {
    const server = sessionServer('pw');
    const h = harness({ fetch: server.fetch });
    const r = await h.cli(['login', '--server', `${SERVER}/`, '--email', 'a@example.com'], {
      prompt: 'pw',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`Signed in to ${SERVER} as a@example.com; saved as profile "default".`);
    const whoami = await h.cli(['whoami']);
    expect(whoami.stdout).toContain('user:    Ann <a@example.com>');
    expect(server.seen.at(-1)?.headers.get('cookie')).toBe('flagship_session=s3cret');
  });

  it('needs a password from somewhere', async () => {
    const h = harness({ fetch: sessionServer('pw').fetch });
    const r = await h.cli(['login', '--server', SERVER, '--email', 'a@example.com']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('no password: pass --password-stdin');
    const empty = await h.cli(['login', '--server', SERVER, '--email', 'a@x', '--password-stdin'], {
      stdin: '\n',
    });
    expect(empty.stderr).toContain('no password on standard input');
    const wrong = await h.cli(['login', '--server', SERVER, '--email', 'a@x', '--password-stdin'], {
      stdin: 'nope\n',
    });
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain('email or password is incorrect');
    expect(
      (await h.cli(['login', '--server', SERVER, '--email', 'a@x', '--token-stdin'])).stderr,
    ).toContain('use either --email or --token-stdin');
    expect((await h.cli(['login', '--server', SERVER])).stderr).toContain(
      'pass --email EMAIL, --token-stdin, or set FLAGSHIP_TOKEN',
    );
  });

  it('takes FLAGSHIP_PASSWORD', async () => {
    const h = harness({ fetch: sessionServer('pw').fetch, env: { FLAGSHIP_PASSWORD: 'pw' } });
    const r = await h.cli(['login', '--server', SERVER, '--email', 'a@example.com', '--json']);
    expect(r.json()).toMatchObject({ auth: 'session', user: 'a@example.com', current: true });
  });

  it('accepts a token the server knows even when it is scoped away from GET /projects', async () => {
    const server = fakeServer({
      'GET /api/projects': (req) =>
        req.headers.get('authorization') === 'Bearer fst_scoped'
          ? apiError(403, 'permission_denied', 'this token is for project shop')
          : req.headers.get('authorization') === 'Bearer fst_boom'
            ? apiError(500, 'internal', 'boom')
            : apiError(401, 'unauthenticated', 'unknown or expired token'),
    });
    const h = harness({ fetch: server.fetch });
    const ok = await h.cli(['login', '--server', SERVER, '--token-stdin', '-p', 'shop'], {
      stdin: 'fst_scoped\n',
    });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('with a token');
    const bad = await h.cli(['login', '--server', SERVER, '--token-stdin'], { stdin: 'fst_bad' });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('the server refused the token: unknown or expired token');
    const boom = await h.cli(['login', '--server', SERVER, '--token-stdin'], { stdin: 'fst_boom' });
    expect(boom.stderr).toContain('boom');
    // The failed attempts left the saved token alone.
    expect((await h.cli(['profile', 'show', '--json'])).json()).toMatchObject({
      auth: 'token',
      project: 'shop',
    });
    expect((await h.cli(['whoami'])).stdout).toContain('auth:    API token');
  });

  it('logs out even when the session already ended', async () => {
    const server = fakeServer({
      'POST /api/session': () =>
        new Response('{"csrfToken":"c"}', {
          headers: { 'set-cookie': 'flagship_session=s; Path=/' },
        }),
      'GET /api/session': () => json({ user: { email: 'a@x' } }),
      'DELETE /api/session': () => apiError(401, 'unauthenticated', 'session expired'),
    });
    const h = harness({ fetch: server.fetch, env: { FLAGSHIP_PASSWORD: 'pw' } });
    await h.cli(['login', '--server', SERVER, '--email', 'a@x']);
    const out = await h.cli(['logout', '--json']);
    expect(out.json()).toEqual({ profile: 'default', signedOut: true, sessionEnded: false });
    expect((await h.cli(['logout'])).stdout).toBe('Profile "default" is not signed in.');
  });

  it('refuses a session cookie it cannot find', async () => {
    const server = fakeServer({ 'POST /api/session': () => json({ csrfToken: 'c' }) });
    const h = harness({ fetch: server.fetch, env: { FLAGSHIP_PASSWORD: 'pw' } });
    const r = await h.cli(['login', '--server', SERVER, '--email', 'a@x']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('returned no session cookie');
  });
});

describe('a broken config file', () => {
  it('is reported, not overwritten', async () => {
    const h = harness();
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(h.dir, 'config'), { recursive: true });
    writeFileSync(h.configFile, '{"version": 9}', { mode: 0o600 });
    const r = await h.cli(['profile', 'list']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('version must be 1');
  });
});
