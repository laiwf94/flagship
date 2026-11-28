import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { FlagCodeBranch, FlagDetail } from '../api';
import { apiError, mockApi, projects, session } from '../../test/server';
import { renderAt } from '../../test/render';

const URL = '/p/default/production/flags/banner?tab=code';

function flag(archived = false): FlagDetail {
  const config = {
    enabled: true,
    offVariant: 'off',
    prerequisites: [],
    rules: [],
    fallthrough: { variant: 'on' },
    version: 1,
    updatedAt: '2030-01-01T00:00:00Z',
  };
  return {
    key: 'banner',
    name: 'Banner',
    description: '',
    type: 'boolean',
    variants: [
      { key: 'on', value: true },
      { key: 'off', value: false },
    ],
    clientSide: false,
    salt: 'banner',
    archived,
    version: 1,
    createdAt: '2030-01-01T00:00:00Z',
    updatedAt: '2030-01-01T00:00:00Z',
    environments: { production: config, development: config },
  };
}

const main: FlagCodeBranch = {
  repository: 'github.com/acme/shop',
  branch: 'main',
  commit: 'abcdef0123456789abcdef0123456789abcdef01',
  urlTemplate: 'https://github.com/acme/shop/blob/{commit}/{path}#L{line}',
  filesScanned: 420,
  scannedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  uploadedBy: 'Eddie (token ci)',
  count: 5,
  hunks: [
    {
      path: 'src/checkout/page.tsx',
      startLine: 10,
      lines: [
        '',
        "  if (flags.get('banner')) {",
        '    show();',
        "  } else if (flags.get('banner')) {",
      ],
      matchLines: [11, 13],
    },
    { path: 'src/checkout/page.tsx', startLine: 40, lines: ["'banner'"], matchLines: [40] },
    { path: 'go/server.go', startLine: 7, lines: [], matchLines: [7, 9] },
  ],
};

const feature: FlagCodeBranch = {
  ...main,
  branch: 'feature/new banner',
  commit: null,
  urlTemplate: null,
  scannedAt: new Date(Date.now() - 60_000).toISOString(),
  count: 9,
  hunks: [{ path: 'a.ts', startLine: 1, lines: ["'banner'"], matchLines: [1] }],
};

const base = () => ({
  'GET /api/session': session,
  'GET /api/projects': projects,
  'GET /api/projects/default/environments/production/ruleset': {
    environment: 'production',
    version: 1,
    flags: {},
    segments: {},
  },
});

describe('code references tab', () => {
  it('shows the default branch first, with source, highlighted lines and links', async () => {
    mockApi({
      ...base(),
      'GET /api/projects/default/flags/banner': flag(),
      'GET /api/projects/default/flags/banner/code-references': { branches: [feature, main] },
    });
    const { user } = renderAt(URL);
    const files = await screen.findByRole('list', { name: 'Files referencing banner' });
    expect(
      within(files)
        .getAllByRole('heading')
        .map((h) => h.textContent),
    ).toEqual(['src/checkout/page.tsx', 'go/server.go']);
    expect(screen.getByText(/5 references in 2 files on/).textContent).toMatch(
      /on github\.com\/acme\/shop main at abcdef012345, scanned 3 hours ago by Eddie \(token ci\)\./,
    );
    const link = within(files).getByRole('link', { name: 'src/checkout/page.tsx line 13' });
    expect(link.getAttribute('href')).toBe(
      `https://github.com/acme/shop/blob/${main.commit}/src/checkout/page.tsx#L13`,
    );
    expect(link.getAttribute('rel')).toContain('noopener');
    const matched = files.querySelectorAll('.code-match');
    expect([...matched].map((m) => m.textContent)).toEqual([
      "11  if (flags.get('banner')) {\n",
      "13  } else if (flags.get('banner')) {\n",
      "40'banner'\n",
    ]);
    // Without source, the line numbers are still links.
    expect(within(files).getByText(/^Lines/).textContent).toBe('Lines 7, 9');
    expect(within(files).getByRole('link', { name: 'go/server.go line 9' })).toBeTruthy();

    await user.selectOptions(
      screen.getByLabelText('Branch'),
      'github.com/acme/shop\u0000feature/new banner',
    );
    expect(await screen.findByText(/9 references in 1 file on/)).toBeTruthy();
    expect(screen.getByText(/Showing the first 1\./)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /line/ })).toBeNull();
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'feature/new banner (9)',
      'main (5)',
    ]);
  });

  it('picks the latest scan without a default branch, and warns on an archived flag', async () => {
    mockApi({
      ...base(),
      'GET /api/projects/default/flags/banner': flag(true),
      'GET /api/projects/default/flags/banner/code-references': {
        branches: [
          { ...main, branch: 'release', scannedAt: '2020-01-01T00:00:00Z' },
          { ...feature, repository: 'github.com/acme/api' },
        ],
      },
    });
    renderAt(URL);
    expect(
      await screen.findByText(
        'This flag is archived but code on feature/new banner still references it.',
      ),
    ).toBeTruthy();
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'github.com/acme/shop · release (5)',
      'github.com/acme/api · feature/new banner (9)',
    ]);
  });

  it('explains how to get references, and retries after an error', async () => {
    let fail = true;
    mockApi({
      ...base(),
      'GET /api/projects/default/flags/banner': flag(true),
      'GET /api/projects/default/flags/banner/code-references': () =>
        fail ? apiError(500, 'internal', 'database is down') : { branches: [] },
    });
    const { user } = renderAt(URL);
    expect(await screen.findByText('database is down')).toBeTruthy();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No references in scanned code')).toBeTruthy();
    expect(screen.getByText(/its cleanup is done/)).toBeTruthy();
  });
});
