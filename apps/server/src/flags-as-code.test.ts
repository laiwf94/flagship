import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdminClient } from '@flagship/admin-client';
import { run, type Io } from '@flagship/cli';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApp, type TestApp } from '../test/app.js';
import { PASSWORD } from '../test/session.js';

let t: TestApp;
let root: AdminClient;
let ed: AdminClient;
let env: Record<string, string>;
const dir = mkdtempSync(join(tmpdir(), 'flagship-code-'));

async function cli(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    readStdin: async () => '',
    env: { FLAGSHIP_CONFIG: join(dir, 'config.json'), ...env },
    cwd: dir,
  };
  const status = await run(argv, io);
  return {
    status,
    stdout: out.join('\n'),
    stderr: err.join('\n'),
    json: () => JSON.parse(out.join('\n')),
  };
}

async function ok(argv: string[]) {
  const r = await cli(argv);
  expect(r.stderr, argv.join(' ')).toBe('');
  expect(r.status, argv.join(' ')).toBe(0);
  return r;
}

function file(name: string, lines: string[]): string {
  writeFileSync(join(dir, name), `${lines.join('\n')}\n`);
  return name;
}

async function auditCount(): Promise<number> {
  const r = await t.db
    .selectFrom('audit_log')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirstOrThrow();
  return r.n;
}

const flag = (key: string) => root.getFlag({ path: { project: 'web', flag: key } }) as Promise<any>;

/** The first version of the file: two flags, development only. */
const V1 = [
  '# managed by the web team',
  'version: 1',
  'project: web',
  'source: github.com/acme/web/flags.yaml',
  'flags:',
  '  new-checkout:',
  '    name: New checkout',
  '    description: One-page checkout',
  '    clientSide: true',
  '    environments:',
  '      development:',
  '        enabled: true',
  '        rules:',
  '          - id: staff',
  '            clauses:',
  '              - { attribute: email, operator: endsWith, values: ["@acme.com"] }',
  '            serve: on',
  '        fallthrough: off',
  '  theme:',
  '    type: string',
  '    variants:',
  '      - { key: light, value: light }',
  '      - { key: dark, value: dark }',
  '      - { key: beta, value: beta-theme }',
  '    environments:',
  '      development:',
  '        enabled: true',
  '        prerequisites: [{ flag: new-checkout, variant: on }]',
  '        offVariant: light',
  '        fallthrough:',
  '          rollout:',
  '            variants:',
  '              - { variant: light, weight: 50000 }',
  '              - { variant: beta, weight: 50000 }',
];

beforeAll(async () => {
  t = await testApp({ bootstrapAdmin: { email: 'root@example.com', password: PASSWORD } });
  await t.app.server.listen({ host: '127.0.0.1', port: 0 });
  const { port } = t.app.server.server.address() as AddressInfo;
  const server = `http://127.0.0.1:${port}`;
  root = await AdminClient.login({ baseUrl: server }, 'root@example.com', PASSWORD);
  await root.createProject({ body: { key: 'web', name: 'Web' } });
  await root.createUser({
    body: { email: 'ed@example.com', name: 'Ed', role: 'editor', password: PASSWORD },
  });
  ed = await AdminClient.login({ baseUrl: server }, 'ed@example.com', PASSWORD);
  const token = (await root.createApiToken({
    body: {
      name: 'flags-as-code',
      scopes: [
        'flags:read',
        'flags:write',
        'projects:read',
        'change-requests:read',
        'change-requests:write',
      ],
      project: 'web',
      expiresInDays: 1,
    },
  })) as { secret: string };
  env = { FLAGSHIP_SERVER: server, FLAGSHIP_TOKEN: token.secret };
});
afterAll(() => t.close());

describe('flags as code against the server', () => {
  it('plans the first apply, applies it, and then has nothing to do', async () => {
    file('flags.yaml', V1);
    const planned = await ok(['plan']);
    expect(planned.stdout).toContain('Plan for project web from flags.yaml');
    expect(planned.stdout).toContain('+ create flag new-checkout (boolean)');
    expect(planned.stdout).toContain('+ create flag theme (string)');
    expect(planned.stdout).toContain('~ enabled: false -> true');
    expect(planned.stdout).toContain('Flags: 2 to create, 0 unchanged.');
    expect((await cli(['plan', '--check'])).status).toBe(3);

    const applied = await ok(['apply', '--json']);
    expect(
      applied.json().applied.map((a: { step: string; flag: string }) => `${a.step} ${a.flag}`),
    ).toEqual([
      'create new-checkout',
      'create theme',
      'targeting new-checkout',
      'targeting theme',
      'record new-checkout',
      'record theme',
    ]);
    const checkout = await flag('new-checkout');
    expect(checkout).toMatchObject({
      name: 'New checkout',
      description: 'One-page checkout',
      clientSide: true,
      managedBy: {
        source: 'github.com/acme/web/flags.yaml',
        metadataVersion: 1,
        environments: { development: 2 },
      },
      environments: {
        development: {
          enabled: true,
          fallthrough: { variant: 'off' },
          rules: [{ id: 'staff', serve: { variant: 'on' } }],
        },
        production: { enabled: false, version: 1 },
      },
    });
    const audit = (await root.searchAudit({
      path: { project: 'web' },
      query: { flag: 'new-checkout' },
    })) as { entries: { reason: string | null }[] };
    expect(audit.entries[0]?.reason).toBe('flagship apply from github.com/acme/web/flags.yaml');

    const again = await ok(['plan']);
    expect(again.stdout).toContain('No changes. 2 flags match the file.');
    expect((await cli(['plan', '--check'])).status).toBe(0);
    const before = await auditCount();
    const idle = await ok(['apply']);
    expect(idle.stdout).toBe('Nothing to apply.');
    expect(await auditCount()).toBe(before);
  });

  it('reports a change made outside the file as drift and puts it back', async () => {
    const live = (await flag('new-checkout')).environments.development;
    await ed.updateTargeting({
      path: { project: 'web', flag: 'new-checkout', environment: 'development' },
      body: {
        version: live.version,
        enabled: false,
        offVariant: live.offVariant,
        prerequisites: live.prerequisites,
        rules: live.rules,
        fallthrough: live.fallthrough,
      },
    });
    const planned = await ok(['plan', '--json']);
    expect(planned.json().summary).toMatchObject({ update: 1, unchanged: 1, drift: 1 });
    const text = await ok(['plan']);
    expect(text.stdout).toContain(
      'development (version 3): [drift: changed outside the file since the last apply]',
    );
    expect(text.stdout).toContain('~ enabled: false -> true');
    expect(text.stdout).toContain('1 with drift.');
    expect((await cli(['plan', '--check'])).status).toBe(3);
    await ok(['apply']);
    expect((await flag('new-checkout')).environments.development).toMatchObject({
      enabled: true,
      version: 4,
    });
    expect((await ok(['plan'])).stdout).toContain('No changes.');
  });

  it('removes a variant that targeting used by moving targeting off it first', async () => {
    const lines = V1.filter((l) => !l.includes('beta')).map((l) =>
      l.includes('variant: light, weight')
        ? '              - { variant: light, weight: 30000 }'
        : l,
    );
    const at = lines.indexOf('              - { variant: light, weight: 30000 }');
    lines.splice(at + 1, 0, '              - { variant: dark, weight: 70000 }');
    file('flags.yaml', lines);
    const planned = await ok(['plan']);
    expect(planned.stdout).toContain('~ update flag theme');
    expect(planned.stdout).toContain('- variants[2]: {"key":"beta","value":"beta-theme"}');
    const applied = await ok(['apply', '--json']);
    expect(applied.json().applied.map((a: { step: string }) => a.step)).toEqual([
      'metadata',
      'targeting',
      'variants',
      'record',
    ]);
    const theme = await flag('theme');
    expect(theme.variants.map((v: { key: string }) => v.key)).toEqual(['light', 'dark']);
    expect(theme.environments.development.fallthrough.rollout.variants).toEqual([
      { variant: 'light', weight: 30000 },
      { variant: 'dark', weight: 70000 },
    ]);
    expect((await ok(['plan'])).stdout).toContain('No changes.');
  });

  it('proposes protected changes as change requests once, and settles after they apply', async () => {
    await root.setRequiredApprovals({
      path: { project: 'web', environment: 'production' },
      body: { requiredApprovals: 1 },
    });
    const lines = [...V1.filter((l) => !l.includes('beta')).slice(0, 18)];
    lines.push('      production:', '        enabled: true', '        fallthrough: on');
    file('flags.yaml', lines);
    const planned = await ok(['plan']);
    expect(planned.stdout).toContain('production (version 1) as a change request:');
    const applied = await ok(['apply', '--json']);
    const proposed = applied
      .json()
      .applied.find((a: { step: string }) => a.step === 'change-request') as {
      changeRequest: string;
    };
    expect(proposed).toMatchObject({ flag: 'new-checkout', environment: 'production' });
    // theme left the file; it is reported, not archived, without --prune.
    expect((await flag('theme')).archived).toBe(false);

    const waiting = await ok(['plan']);
    expect(waiting.stdout).toContain(
      `production: change request ${proposed.changeRequest} already proposes this; waiting for approval`,
    );
    expect(waiting.stdout).toContain(
      '! flag theme was managed by this file but is not in it; --prune archives it',
    );
    const requests = async () =>
      (
        (await root.listChangeRequests({
          path: { project: 'web' },
          query: { status: 'open' },
        })) as {
          changeRequests: unknown[];
        }
      ).changeRequests.length;
    expect(await requests()).toBe(1);
    await ok(['apply']);
    expect(await requests()).toBe(1);

    await ed.reviewChangeRequest({
      path: { project: 'web', id: proposed.changeRequest },
      body: { revision: 1, decision: 'approve' },
    });
    await ed.applyChangeRequest({
      path: { project: 'web', id: proposed.changeRequest },
      body: { revision: 1 },
    });
    expect((await flag('new-checkout')).environments.production.enabled).toBe(true);
    const settled = await ok(['plan', '--json']);
    expect(settled.json().summary).toMatchObject({ orphan: 1, pending: 0, drift: 0 });
    await ok(['apply', '--prune']);
    expect((await flag('theme')).archived).toBe(true);
    expect((await flag('new-checkout')).managedBy.environments).toEqual({
      development: 4,
      production: 2,
    });
    expect((await ok(['plan'])).stdout).toContain('No changes. 1 flag match the file.');
  });

  it('applies a saved plan exactly, and refuses it once the flag moved on', async () => {
    const lines = V1.slice(0, 18).map((l) =>
      l.includes('name: New checkout') ? '    name: Checkout v2' : l,
    );
    lines.push('      production:', '        enabled: true', '        fallthrough: on');
    file('flags.yaml', lines);
    await ok(['plan', '--out', 'plan.json']);
    expect(JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8'))).toMatchObject({
      format: 'flagship-plan',
      project: 'web',
      summary: { update: 1 },
    });
    const current = await flag('new-checkout');
    await ed.updateFlag({
      path: { project: 'web', flag: 'new-checkout' },
      body: { version: current.version, description: 'edited in the console' },
    });
    const stale = await cli(['apply', '--plan', 'plan.json']);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain('updating new-checkout failed');
    expect(stale.stderr).toContain('something changed since the plan: plan again');

    await ok(['plan', '--out', 'plan.json']);
    const done = await ok(['apply', '--plan', 'plan.json']);
    expect(done.stdout).toContain('Updated new-checkout (version');
    expect(await flag('new-checkout')).toMatchObject({
      name: 'Checkout v2',
      description: 'One-page checkout',
    });
    expect((await cli(['apply', 'flags.yaml', '--plan', 'plan.json'])).status).toBe(2);
    file('not-a-plan.json', ['{"format": "other"}']);
    expect((await cli(['apply', '--plan', 'not-a-plan.json'])).stderr).toContain(
      'is not a plan saved by flagship plan --out',
    );
  });

  it('reports problems at their lines before writing anything', async () => {
    const before = await auditCount();
    file('bad.yaml', [
      'version: 1',
      'project: web',
      'flags:',
      '  broken:',
      '    environments:',
      '      development:',
      '        enabled: true',
      '        rules:',
      '          - id: r1',
      '            clauses: [{ operator: inSegment, segments: [nobody] }]',
      '            serve: on',
      '        fallthrough: maybe',
      '      staging: {}',
    ]);
    const bad = await cli(['plan', 'bad.yaml']);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('flagship: bad.yaml has a problem');
    expect(bad.stderr).toContain(
      'bad.yaml:13: flags.broken.environments.staging: the project has no environment "staging"',
    );
    file('bad.yaml', [
      'version: 1',
      'project: web',
      'flags:',
      '  broken:',
      '    environments:',
      '      development:',
      '        enabled: true',
      '        rules:',
      '          - id: r1',
      '            clauses: [{ operator: inSegment, segments: [nobody] }]',
      '            serve: on',
      '        fallthrough: maybe',
    ]);
    const refs = await cli(['plan', 'bad.yaml', '--json']);
    const details = JSON.parse(refs.stderr).error.details;
    expect(details).toHaveLength(2);
    expect(details).toEqual(
      expect.arrayContaining([
        {
          file: 'bad.yaml',
          line: 10,
          path: 'flags.broken.environments.development.rules[0].clauses[0].segments[0]',
          message: 'unknown segment "nobody"',
        },
        {
          file: 'bad.yaml',
          line: 12,
          path: 'flags.broken.environments.development.fallthrough.variant',
          message: 'unknown variant "maybe"',
        },
      ]),
    );
    file('bad.yaml', ['version: 1', 'flags:', '  x:', '    name: [unclosed']);
    const syntax = await cli(['plan', 'bad.yaml', '-p', 'web']);
    expect(syntax.stderr).toContain(
      'bad.yaml:4: column 11: a [ list ] must close on the same line',
    );
    file('bad.yaml', ['version: 1', 'project: web', 'flags:', '  theme:', '    type: boolean']);
    expect((await cli(['plan', 'bad.yaml'])).stderr).toContain(
      "bad.yaml:5: flags.theme.type: is string on the server; a flag's type can't change",
    );
    expect((await cli(['plan', 'bad.yaml', '-p', 'other'])).stderr).toContain(
      'bad.yaml is for project "web", not "other"',
    );
    expect((await cli(['plan', 'missing.yaml'])).stderr).toContain(
      "can't read flags file missing.yaml",
    );
    expect(await auditCount()).toBe(before);
  });

  it('refuses flags another file manages unless taking over', async () => {
    file('other.yaml', [
      'version: 1',
      'project: web',
      'source: other-repo/flags.yaml',
      'flags:',
      '  new-checkout:',
      '    name: Checkout v2',
      '    description: One-page checkout',
      '    clientSide: true',
    ]);
    const refused = await cli(['plan', 'other.yaml']);
    expect(refused.stderr).toContain(
      'other.yaml:5: flags.new-checkout: is managed by github.com/acme/web/flags.yaml',
    );
    const taken = await ok(['plan', 'other.yaml', '--take-over']);
    expect(taken.stdout).toContain('No changes. 1 flag match the file.');
    await ok(['apply', 'other.yaml', '--take-over']);
    expect((await flag('new-checkout')).managedBy).toMatchObject({
      source: 'other-repo/flags.yaml',
      environments: {},
    });
  });

  it('pulls live flags into a file that plans clean', async () => {
    await root.createFlag({
      path: { project: 'web' },
      body: {
        key: 'pricing',
        name: 'Pricing',
        type: 'json',
        variants: [
          { key: 'a', value: { price: 10, currency: 'NZD' } },
          { key: 'b', value: { price: 12, currency: 'NZD' }, name: 'Twelve' },
        ],
      },
    });
    const pulled = await ok(['pull', '-p', 'web', '--flag', 'pricing', '--flag', 'new-checkout']);
    expect(pulled.stdout).toContain('version: 1\nproject: web\nflags:\n  pricing:');
    await ok([
      'pull',
      '-p',
      'web',
      '--environments',
      'development,production',
      '--source',
      'pulled.yaml',
      '--out',
      'pulled.yaml',
    ]);
    const plan = await ok(['plan', 'pulled.yaml', '--take-over', '--json']);
    expect(plan.json().summary).toMatchObject({ create: 0, update: 0, unchanged: 2 });
    expect(
      plan
        .json()
        .flags.every(
          (f: { metadata: unknown; environments: unknown[] }) =>
            f.metadata === null && f.environments.length === 0,
        ),
    ).toBe(true);
    expect((await cli(['plan', 'pulled.yaml', '--take-over', '--check'])).status).toBe(0);
    expect((await cli(['pull', '-p', 'web', '--environments', 'staging'])).stderr).toContain(
      'has no environment staging',
    );
  });
});
