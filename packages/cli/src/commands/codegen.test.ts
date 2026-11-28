import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeServer, json } from '../../test/fake-server.js';
import { harness } from '../../test/memory-io.js';
import { generateTypeScript } from '../codegen.js';

const flag = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  name: key,
  description: '',
  type: 'boolean',
  variants: [
    { key: 'on', value: true },
    { key: 'off', value: false },
  ],
  clientSide: false,
  archived: false,
  version: 1,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  environments: {},
  managedBy: null,
  ...extra,
});

const theme = flag('theme', {
  name: 'Theme',
  type: 'string',
  clientSide: true,
  variants: [
    { key: 'light', value: 'light' },
    { key: 'dark', value: 'dark' },
  ],
});

/** 501 flags, so listing takes two pages. */
const KEYS = Array.from({ length: 501 }, (_, i) => `f${String(i).padStart(3, '0')}`);

function setup(env: Record<string, string> = {}) {
  const server = fakeServer({
    'GET /api/projects/shop': () =>
      json({ key: 'shop', name: 'Shop', environments: [{ key: 'development' }] }),
    'GET /api/projects/shop/flags': (req) => {
      const after = req.query.get('after');
      const rest = after === null ? KEYS : KEYS.filter((k) => k > after);
      const page = rest.slice(0, Number(req.query.get('limit')));
      return json({
        flags: page.map((key) => ({ key, status: key === 'f001' ? 'archived' : 'on' })),
      });
    },
    ...Object.fromEntries(
      KEYS.map((k) => [
        `GET /api/projects/shop/flags/${k}`,
        () => json(k === 'f000' ? { ...theme, key: k } : flag(k)),
      ]),
    ),
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

const FLAGS_YAML = [
  'version: 1',
  'project: shop',
  'flags:',
  '  new-checkout:',
  '    name: New checkout',
  '    clientSide: true',
  '  theme:',
  '    type: string',
  '    variants:',
  '      - { key: light, value: light }',
  '      - { key: dark, value: dark }',
  '',
].join('\n');

describe('flagship codegen', () => {
  it('reads every live flag from the server, two pages and eight at a time', async () => {
    const h = setup();
    const r = await h.cli(['codegen', '--lang', 'ts', '--json']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const out = r.json();
    expect(out).toMatchObject({ project: 'shop', lang: 'typescript', flags: 500, file: null });
    const pages = h.server.seen.filter((s) => s.path === '/api/projects/shop/flags');
    expect(pages.map((p) => [p.query.get('environment'), p.query.get('after')])).toEqual([
      ['development', null],
      ['development', 'f499'],
    ]);
    // The archived flag is left out, and no flag is fetched twice.
    const gets = h.server.seen.filter((s) => s.path.startsWith('/api/projects/shop/flags/'));
    expect(gets).toHaveLength(500);
    expect(gets.some((g) => g.path.endsWith('/f001'))).toBe(false);
    expect(out.code).toContain('  f000: "light" | "dark";');
    expect(out.code).toContain('f500: boolean;');
    expect(out.code).not.toContain('f001');
  });

  it('writes a Go file named after its directory, then --check passes until a flag changes', async () => {
    const h = setup({ FLAGSHIP_ENVIRONMENT: 'development' });
    const w = await h.cli(['codegen', '--out', 'internal/featureflags/flags.go']);
    expect(w.stderr).toBe('');
    expect(w.stdout).toBe('Wrote 500 flag accessors for Go to internal/featureflags/flags.go.');
    const code = readFileSync(join(h.dir, 'internal/featureflags/flags.go'), 'utf8');
    expect(code).toContain('package featureflags\n');
    expect(code).toContain('\tF000Light F000Value = "light"\n');

    const ok = await h.cli(['codegen', '--out', 'internal/featureflags/flags.go', '--check']);
    expect(ok).toMatchObject({
      status: 0,
      stdout: 'internal/featureflags/flags.go is up to date (500 flags).',
    });

    writeFileSync(join(h.dir, 'internal/featureflags/flags.go'), code.replace('"dark"', '"dim"'));
    const stale = await h.cli([
      'codegen',
      '--out',
      'internal/featureflags/flags.go',
      '--check',
      '--json',
    ]);
    expect(stale.status).toBe(3);
    const line = code.split('\n').findIndex((l) => l.includes('"dark"')) + 1;
    expect(stale.json()).toEqual({
      project: 'shop',
      lang: 'go',
      flags: 500,
      file: 'internal/featureflags/flags.go',
      upToDate: false,
      firstDifferentLine: line,
    });
    // --check never writes.
    expect(readFileSync(join(h.dir, 'internal/featureflags/flags.go'), 'utf8')).toContain('"dim"');
  });

  it('generates from a flags file with no server at all', async () => {
    const h = harness({ env: {} });
    writeFileSync(join(h.dir, 'flags.yaml'), FLAGS_YAML);
    const r = await h.cli(['codegen', '--file', 'flags.yaml', '--out', 'src/flags.ts']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const code = readFileSync(join(h.dir, 'src/flags.ts'), 'utf8');
    const expected = generateTypeScript({
      project: 'shop',
      flags: [
        {
          key: 'new-checkout',
          name: 'New checkout',
          description: '',
          type: 'boolean',
          clientSide: true,
          variants: [
            { key: 'on', value: true },
            { key: 'off', value: false },
          ],
        },
        {
          key: 'theme',
          name: 'theme',
          description: '',
          type: 'string',
          clientSide: false,
          variants: [
            { key: 'light', value: 'light' },
            { key: 'dark', value: 'dark' },
          ],
        },
      ],
    });
    expect(code).toBe(expected);
    const go = await h.cli(['codegen', '--file', 'flags.yaml', '--lang', 'go', '--package', 'ff']);
    expect(go.stdout).toContain('package ff\n');
    expect(go.stdout).toContain(
      'func (f Flags[C]) Theme(context C, fallback ThemeValue) ThemeValue {',
    );

    const missing = await h.cli([
      'codegen',
      '--file',
      'flags.yaml',
      '--out',
      'src/other.ts',
      '--check',
    ]);
    expect(missing).toMatchObject({
      status: 3,
      stdout:
        'src/other.ts does not exist: run flagship codegen --out src/other.ts and commit the result.',
    });
  });

  it('refuses unclear or conflicting options', async () => {
    const h = harness({ env: { FLAGSHIP_PROJECT: 'web' } });
    writeFileSync(join(h.dir, 'flags.yaml'), FLAGS_YAML);
    mkdirSync(join(h.dir, 'dir.ts'));
    const cases: [string[], string][] = [
      [['codegen'], 'pass --lang typescript or --lang go, or an --out file ending .ts or .go'],
      [['codegen', '--out', 'x.py'], 'pass --lang typescript or --lang go'],
      [['codegen', '--lang', 'rust'], '--lang must be one of typescript, go, ts, not "rust"'],
      [['codegen', '--lang', 'go', '--check'], '--check compares with --out: pass both'],
      [['codegen', '--lang', 'ts', '--package', 'x'], '--package is for --lang go'],
      [['codegen', '--lang', 'go', '--package', 'Bad'], '--package "Bad" is not a Go package name'],
      [['codegen', '--lang', 'go', '--file', 'nope.yaml'], "can't read flags file nope.yaml"],
      [
        ['codegen', '--lang', 'go', '--file', 'flags.yaml'],
        'flags.yaml is for project "shop", not "web"',
      ],
      [
        ['codegen', '--file', 'flags.yaml', '--out', 'dir.ts', '--check', '-p', 'shop'],
        "can't read dir.ts",
      ],
    ];
    for (const [argv, message] of cases) {
      const r = await h.cli(argv);
      expect(r.status, argv.join(' ')).toBe(2);
      expect(r.stderr, argv.join(' ')).toContain(message);
    }
  });

  it('reports clashing names with each flag', async () => {
    const h = harness();
    writeFileSync(
      join(h.dir, 'flags.yaml'),
      ['version: 1', 'project: shop', 'flags:', '  new-checkout:', '  new_checkout:', ''].join(
        '\n',
      ),
    );
    const r = await h.cli(['codegen', '--file', 'flags.yaml', '--lang', 'ts', '--json']);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stderr)).toEqual({
      error: {
        code: 'codegen_name_clash',
        message:
          'generated names clash: flag "new-checkout" and flag "new_checkout" both become newCheckout. Rename one of the flags or variants',
        details: [
          {
            path: '',
            message: 'flag "new-checkout" and flag "new_checkout" both become newCheckout',
          },
        ],
      },
    });
  });
});
