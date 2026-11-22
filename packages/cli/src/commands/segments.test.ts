import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeServer, json } from '../../test/fake-server.js';
import { harness } from '../../test/memory-io.js';

const live = {
  key: 'beta',
  name: 'Beta',
  description: '',
  included: Array.from({ length: 12 }, (_, i) => `u${i}`),
  excluded: [],
  rules: [],
  version: 4,
  updatedAt: '2026-11-22T05:00:00.000Z',
};

function setup() {
  const server = fakeServer({
    'GET /api/projects/shop/environments/production/segments/beta': () => json(live),
    'PUT /api/projects/shop/environments/production/segments/beta': (req) =>
      json({ ...live, ...(req.body as object), version: 5 }),
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

describe('segment files', () => {
  it('refuses fields of the wrong type', async () => {
    const h = setup();
    const cases: [unknown, string][] = [
      [[1], 'segment must be a JSON object'],
      [{ name: 1 }, 'segment name must be a string'],
      [{ description: false }, 'segment description must be a string'],
      [{ included: 'a' }, 'included must be an array of strings'],
      [{ excluded: [1] }, 'excluded must be an array of strings'],
      [{ rules: {} }, 'segment rules must be an array'],
    ];
    for (const [content, message] of cases) {
      writeFileSync(join(h.dir, 'seg.json'), JSON.stringify(content));
      const r = await h.cli(['segment', 'update', 'beta', '--file', 'seg.json']);
      expect(r.status, message).toBe(2);
      expect(r.stderr).toContain(message);
    }
  });

  it('sends the version read, or the pinned one, and previews long member lists', async () => {
    const h = setup();
    writeFileSync(
      join(h.dir, 'seg.json'),
      JSON.stringify({ name: 'Renamed', excluded: ['x'], version: 99 }),
    );
    await h.cli(['segment', 'update', 'beta', '--file', 'seg.json', '--description', 'Early']);
    expect(h.server.seen.at(-1)?.body).toEqual({
      version: 4,
      name: 'Renamed',
      description: 'Early',
      included: live.included,
      excluded: ['x'],
      rules: [],
    });
    await h.cli(['segment', 'update', 'beta', '--name', 'B', '--if-version', '3']);
    expect(h.server.seen.at(-1)?.body).toMatchObject({ version: 3, name: 'B' });
    const shown = await h.cli(['segment', 'get', 'beta']);
    expect(shown.stdout).toContain(
      'included:    12: u0, u1, u2, u3, u4, u5, u6, u7, u8, u9, ... (--json for all)',
    );
    expect(shown.stdout).toContain('excluded:    0');
  });
});
