import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeServer, json } from '../../test/fake-server.js';
import { harness } from '../../test/memory-io.js';

const variants = [
  { key: 'on', value: true },
  { key: 'off', value: false },
];

const targeting = {
  enabled: true,
  offVariant: 'off',
  prerequisites: [],
  rules: [],
  fallthrough: { variant: 'on' },
  version: 6,
  updatedAt: '2026-11-22T05:00:00.000Z',
};

const live = {
  key: 'checkout',
  name: 'Checkout',
  description: '',
  type: 'boolean',
  variants,
  clientSide: false,
  archived: false,
  version: 3,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-22T05:00:00.000Z',
  environments: { production: targeting },
};

const summary = (key: string) => ({
  key,
  name: key,
  type: 'boolean',
  version: 1,
  targetingVersion: 1,
  updatedAt: '2026-11-22T05:00:00.000Z',
  status: 'on',
  ruleCount: 0,
  lifecycle: { stage: 'active', stale: false },
  lastEvaluatedAt: null,
});

function setup(extra: Parameters<typeof fakeServer>[0] = {}) {
  const server = fakeServer({
    'GET /api/projects/shop/flags/checkout': () => json(live),
    'PUT /api/projects/shop/flags/checkout': (req) =>
      json({ ...live, ...(req.body as object), version: 4 }),
    'PUT /api/projects/shop/flags/checkout/environments/production': (req) =>
      json({
        ...live,
        environments: { production: { ...targeting, ...(req.body as object), version: 7 } },
      }),
    ...extra,
  });
  const h = harness({
    fetch: server.fetch,
    env: {
      FLAGSHIP_TOKEN: 'fst_t',
      FLAGSHIP_SERVER: 'http://flags.test',
      FLAGSHIP_PROJECT: 'shop',
      FLAGSHIP_ENVIRONMENT: 'production',
    },
  });
  return { ...h, server };
}

describe('flag list', () => {
  it('follows the cursor with --all and stops after the first page without it', async () => {
    const pages = [[summary('a'), summary('b')], [summary('c'), summary('d')], [summary('e')]];
    const h = setup({
      'GET /api/projects/shop/flags': (req) => {
        const after = req.query.get('after');
        const index = after === null ? 0 : after === 'b' ? 1 : 2;
        return json({ flags: pages[index] });
      },
    });
    const all = await h.cli(['flag', 'list', '--limit', '2', '--all', '--json']);
    expect(all.status).toBe(0);
    expect(all.json().flags.map((f: { key: string }) => f.key)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(h.server.seen.map((r) => r.query.get('after'))).toEqual([null, 'b', 'd']);

    const first = await h.cli(['flag', 'list', '--limit', '2', '--json']);
    expect(first.json().flags).toHaveLength(2);
    expect(h.server.seen).toHaveLength(4);
  });

  it('refuses limits outside 1 to 500 and unknown statuses', async () => {
    const h = setup();
    for (const args of [
      ['--limit', '0'],
      ['--limit', '501'],
      ['--status', 'paused'],
    ]) {
      const r = await h.cli(['flag', 'list', ...args]);
      expect(r.status, args.join(' ')).toBe(2);
    }
    expect(h.server.seen).toHaveLength(0);
  });
});

describe('flag update', () => {
  it('refuses a call that changes nothing, before it reads or writes anything', async () => {
    const h = setup();
    const r = await h.cli(['flag', 'update', 'checkout']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('nothing to change');
    expect(h.server.seen).toHaveLength(1);
    expect(h.server.seen.every((s) => s.method === 'GET')).toBe(true);
  });

  it('refuses --client-side together with --server-only', async () => {
    const h = setup();
    const r = await h.cli(['flag', 'update', 'checkout', '--client-side', '--server-only']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('use either --client-side or --server-only');
    expect(h.server.seen.some((s) => s.method === 'PUT')).toBe(false);
  });

  it('sends the version it read, or the pinned one', async () => {
    const h = setup();
    await h.cli(['flag', 'update', 'checkout', '--name', 'Pay']);
    expect(h.server.seen.at(-1)?.body).toEqual({ version: 3, name: 'Pay' });
    h.server.seen.length = 0;
    await h.cli(['flag', 'update', 'checkout', '--server-only', '--if-version', '2']);
    expect(h.server.seen).toHaveLength(1);
    expect(h.server.seen[0]?.body).toEqual({ version: 2, clientSide: false });
  });

  it('refuses --variants that is not a JSON array', async () => {
    const h = setup();
    const r = await h.cli(['flag', 'update', 'checkout', '--variants', '{"key":"a"}']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--variants must be a JSON array');
  });
});

describe('flag target', () => {
  it('needs --file', async () => {
    const h = setup();
    const r = await h.cli(['flag', 'target', 'checkout']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('pass --file PATH');
  });

  it('names the fields a targeting file is missing', async () => {
    const h = setup();
    writeFileSync(join(h.dir, 't.json'), JSON.stringify({ enabled: true, rules: [] }));
    const r = await h.cli(['flag', 'target', 'checkout', '--file', 't.json']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('is missing offVariant, prerequisites, fallthrough');
    expect(h.server.seen.some((s) => s.method === 'PUT')).toBe(false);
  });

  it('ignores other fields and sends the environment version it read', async () => {
    const h = setup();
    const { version: _v, updatedAt: _u, ...edited } = { ...targeting, enabled: false };
    writeFileSync(join(h.dir, 't.json'), JSON.stringify({ ...edited, version: 99, extra: 1 }));
    const r = await h.cli(['flag', 'target', 'checkout', '--file', 't.json']);
    expect(r.status).toBe(0);
    expect(h.server.seen.at(-1)?.body).toEqual({ version: 6, ...edited });
    expect(r.stdout).toContain('Updated checkout in production (now version 7)');

    await h.cli(['flag', 'target', 'checkout', '--file', 't.json', '--if-version', '5']);
    expect(h.server.seen.at(-1)?.body).toMatchObject({ version: 5 });
  });

  it('names the environments a flag does have when the selected one is missing', async () => {
    const h = setup();
    writeFileSync(join(h.dir, 't.json'), JSON.stringify(targeting));
    const r = await h.cli([
      'flag',
      'target',
      'checkout',
      '--file',
      't.json',
      '--environment',
      'staging',
    ]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('flag "checkout" has no environment "staging"; it has production');
  });
});
