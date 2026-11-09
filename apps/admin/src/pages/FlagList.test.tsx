import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { apiError, mockApi, projects, session } from '../../test/server';
import { renderAt } from '../../test/render';

const flag = (key: string, status: string, extra: Record<string, unknown> = {}) => ({
  key,
  name: key.replace(/-/g, ' '),
  description: '',
  type: 'boolean',
  clientSide: false,
  version: 1,
  targetingVersion: 1,
  updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
  status,
  ruleCount: 0,
  lifecycle: { stage: 'active', stale: false, reasons: [] },
  lastEvaluatedAt: null,
  ...extra,
});

describe('flag list', () => {
  it('lists flags with status badges and filters by chip and search', async () => {
    const api = mockApi({
      'GET /api/session': session,
      'GET /api/projects': projects,
      'GET /api/projects/default/flags': (_b: unknown, url: URL) => {
        const status = url.searchParams.get('status');
        const q = url.searchParams.get('q');
        const all = [
          flag('new-checkout', 'rollout', { type: 'string' }),
          flag('dark-mode', 'on'),
          flag('old-search', 'off'),
        ];
        return {
          flags: all.filter(
            (f) => (status === null || f.status === status) && (q === null || f.key.includes(q)),
          ),
        };
      },
    });
    const { user } = renderAt('/p/default/production/flags');
    const list = await screen.findByRole('list', { name: 'Flags' });
    expect(within(list).getByText('new checkout')).toBeTruthy();
    expect(within(list).getByText('Rolling out')).toBeTruthy();
    expect(within(list).getByText('String')).toBeTruthy();
    expect(within(list).getAllByText('1 hour ago')).toHaveLength(3);
    expect(within(list).getAllByRole('link')[0]?.getAttribute('href')).toBe(
      '/p/default/production/flags/new-checkout',
    );

    await user.click(screen.getByRole('button', { name: 'On' }));
    await waitFor(() => {
      expect(screen.queryByText('new checkout')).toBeNull();
    });
    expect(screen.getByRole('button', { name: 'On' }).getAttribute('aria-pressed')).toBe('true');
    expect(api.calls.at(-1)?.path).toContain('status=on');

    await user.click(screen.getByRole('button', { name: 'All' }));
    await user.type(screen.getByLabelText('Search flags'), 'old');
    await waitFor(() => {
      expect(api.calls.at(-1)?.path).toContain('q=old');
    });
    await waitFor(() => {
      expect(screen.queryByText('dark mode')).toBeNull();
    });

    await user.clear(screen.getByLabelText('Search flags'));
    await user.type(screen.getByLabelText('Search flags'), 'zzz');
    expect(await screen.findByText('No flags match')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText('dark mode')).toBeTruthy();
  });

  it('links every section from the sidebar', async () => {
    mockApi({
      'GET /api/session': session,
      'GET /api/projects': projects,
      'GET /api/projects/default/flags': { flags: [] },
    });
    renderAt('/p/default/production/flags');
    const nav = await screen.findByRole('navigation', { name: 'Sections' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((a) => [a.textContent, a.getAttribute('href')]),
    ).toEqual([
      ['Flags', '/p/default/production/flags'],
      ['Segments', '/p/default/production/segments'],
      ['Changes', '/p/default/production/change-requests'],
      ['History', '/p/default/production/history'],
      ['Settings', '/p/default/production/settings'],
    ]);
  });

  it('shows an empty state that invites editors to create the first flag', async () => {
    mockApi({
      'GET /api/session': session,
      'GET /api/projects': projects,
      'GET /api/projects/default/flags': { flags: [] },
    });
    renderAt('/p/default/production/flags');
    expect(await screen.findByText('No flags yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create your first flag' })).toBeTruthy();
  });

  it('hides creation from viewers', async () => {
    mockApi({
      'GET /api/session': { ...session, user: { ...session.user, role: 'viewer' } },
      'GET /api/projects': projects,
      'GET /api/projects/default/flags': { flags: [] },
    });
    renderAt('/p/default/production/flags');
    expect(await screen.findByText('No flags yet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /create/i })).toBeNull();
  });

  it('shows an error with a retry', async () => {
    let fail = true;
    mockApi({
      'GET /api/session': session,
      'GET /api/projects': projects,
      'GET /api/projects/default/flags': () =>
        fail
          ? apiError(503, 'unavailable', 'database is unreachable')
          : { flags: [flag('recovered', 'on')] },
    });
    const { user } = renderAt('/p/default/production/flags');
    expect(await screen.findByText('database is unreachable')).toBeTruthy();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('recovered', { selector: 'strong' })).toBeTruthy();
  });

  it('switches environment and keeps the page', async () => {
    const api = mockApi({
      'GET /api/session': session,
      'GET /api/projects': projects,
      'GET /api/projects/default/flags': { flags: [] },
    });
    const { user } = renderAt('/p/default/production/flags?status=off');
    await screen.findByText('No flags match');
    await user.click(screen.getByRole('radio', { name: 'Development' }));
    await waitFor(() => {
      expect(api.calls.at(-1)?.path).toContain('environment=development');
    });
    expect(api.calls.at(-1)?.path).toContain('status=off');
  });
});

describe('flag lifecycle', () => {
  const since = '2030-04-01T09:00:00.000Z';

  it('marks new and stale flags in the list with the reason', async () => {
    mockApi({
      'GET /api/session': session,
      'GET /api/projects': projects,
      'GET /api/projects/default/flags': {
        flags: [
          flag('brand-new', 'off', { lifecycle: { stage: 'new', stale: false, reasons: [] } }),
          flag('in-use', 'rollout'),
          flag('done', 'on', {
            lifecycle: {
              stage: 'launched',
              stale: true,
              reasons: [{ kind: 'launched', variant: 'on', enabled: true, since }],
            },
          }),
        ],
      },
    });
    renderAt('/p/default/production/flags');
    const list = await screen.findByRole('list', { name: 'Flags' });
    const rows = within(list).getAllByRole('link');
    expect(within(rows[0] as HTMLElement).getByText('New')).toBeTruthy();
    expect(within(rows[1] as HTMLElement).queryByText('Active')).toBeNull();
    expect(within(rows[2] as HTMLElement).getByText('Launched')).toBeTruthy();
    expect(rows[2]?.textContent).toContain('Serves on to everyone, unchanged since 2030-04-01');
    expect(
      within(rows[2] as HTMLElement)
        .getByText('Launched')
        .closest('.lifecycle-chip')
        ?.getAttribute('title'),
    ).toBe('Serves on to everyone, unchanged since 2030-04-01');
  });

  it('lists stale flags with their reasons in the cleanup view', async () => {
    const api = mockApi({
      'GET /api/session': session,
      'GET /api/projects': projects,
      'GET /api/projects/default/flags': { flags: [flag('in-use', 'on')] },
      'GET /api/projects/default/environments/production/stale-flags': {
        staleAfterDays: 30,
        flags: [
          {
            key: 'old-banner',
            name: 'Old banner',
            stage: 'inactive',
            reasons: [
              { kind: 'unevaluated', lastEvaluatedAt: since, since },
              { kind: 'launched', variant: 'off', enabled: false, since },
            ],
            lastEvaluatedAt: since,
            targetingChangedAt: since,
          },
          {
            key: 'never-used',
            name: 'Never used',
            stage: 'inactive',
            reasons: [{ kind: 'unevaluated', lastEvaluatedAt: null, since }],
            lastEvaluatedAt: null,
            targetingChangedAt: since,
          },
        ],
      },
      'GET /api/projects/default/environments/development/stale-flags': {
        staleAfterDays: 30,
        flags: [],
      },
    });
    const { user } = renderAt('/p/default/production/flags');
    await screen.findByRole('list', { name: 'Flags' });
    await user.click(screen.getByRole('button', { name: 'Cleanup' }));
    const list = await screen.findByRole('list', { name: 'Stale flags' });
    expect(screen.getByRole('button', { name: 'Cleanup' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.queryByLabelText('Search flags')).toBeNull();
    const rows = within(list).getAllByRole('link');
    expect(rows.map((r) => r.getAttribute('href'))).toEqual([
      '/p/default/production/flags/old-banner',
      '/p/default/production/flags/never-used',
    ]);
    expect(within(rows[0] as HTMLElement).getByText('Not evaluated since 2030-04-01')).toBeTruthy();
    expect(
      within(rows[0] as HTMLElement).getByText(
        'Switched off (serves off to everyone) since 2030-04-01',
      ),
    ).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText('Never')).toBeTruthy();
    expect(screen.getByText(/in Production for 30 days or more/)).toBeTruthy();

    await user.click(screen.getByRole('radio', { name: 'Development' }));
    expect(await screen.findByText('Nothing to clean up')).toBeTruthy();
    expect(api.calls.at(-1)?.path).toBe(
      '/api/projects/default/environments/development/stale-flags',
    );

    await user.click(screen.getByRole('button', { name: 'All flags' }));
    expect(await screen.findByRole('list', { name: 'Flags' })).toBeTruthy();
  });

  it('shows an error with a retry in the cleanup view', async () => {
    let fail = true;
    mockApi({
      'GET /api/session': session,
      'GET /api/projects': projects,
      'GET /api/projects/default/environments/production/stale-flags': () =>
        fail
          ? apiError(503, 'unavailable', 'database is unreachable')
          : { staleAfterDays: 30, flags: [] },
    });
    const { user } = renderAt('/p/default/production/flags?view=cleanup');
    expect(await screen.findByText('database is unreachable')).toBeTruthy();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Nothing to clean up')).toBeTruthy();
  });
});

describe('create flag dialog', () => {
  it('derives the key from the name, validates inline and creates the flag', async () => {
    const api = mockApi({
      'GET /api/session': session,
      'GET /api/projects': projects,
      'GET /api/projects/default/flags': { flags: [] },
      'POST /api/projects/default/flags': (body: unknown) => ({
        ...(body as object),
        environments: {},
        version: 1,
      }),
    });
    const { user } = renderAt('/p/default/production/flags');
    await user.click(await screen.findByRole('button', { name: 'Create flag' }));
    const dialog = screen.getByRole('dialog', { name: 'Create flag' });
    expect(document.activeElement).toBe(within(dialog).getByLabelText('Name'));

    await user.click(within(dialog).getByRole('button', { name: 'Create flag' }));
    expect(within(dialog).getByText('Give the flag a name')).toBeTruthy();
    expect(within(dialog).getByLabelText('Name').getAttribute('aria-invalid')).toBe('true');

    await user.type(within(dialog).getByLabelText('Name'), 'Pricing Page v2!');
    expect(within(dialog).getByLabelText<HTMLInputElement>('Key').value).toBe('pricing-page-v2');

    await user.click(within(dialog).getByRole('radio', { name: 'Number' }));
    const value = within(dialog).getByLabelText('Variant 1 value');
    await user.clear(value);
    await user.type(value, 'ten');
    await user.click(within(dialog).getByRole('button', { name: 'Add variant' }));
    await user.click(within(dialog).getByRole('button', { name: 'Remove variant 3' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create flag' }));
    expect(within(dialog).getByText('Enter a number, like 10 or 2.5')).toBeTruthy();
    await user.clear(value);
    await user.type(value, '10');
    await user.click(within(dialog).getByRole('switch', { name: /browser and mobile/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Create flag' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    const post = api.calls.find((c) => c.method === 'POST');
    expect(post?.body).toEqual({
      key: 'pricing-page-v2',
      name: 'Pricing Page v2!',
      description: '',
      type: 'number',
      variants: [
        { key: 'low', value: 10 },
        { key: 'high', value: 50 },
      ],
      clientSide: true,
    });
    expect(post?.headers['x-csrf-token']).toBe('csrf-token');
    expect(await screen.findByText(/Created Pricing Page v2!/)).toBeTruthy();
  });

  it('reports duplicate keys at the key field and validates JSON and duplicate variants', async () => {
    mockApi({
      'GET /api/session': session,
      'GET /api/projects': projects,
      'GET /api/projects/default/flags': { flags: [] },
      'POST /api/projects/default/flags': apiError(409, 'already_exists', 'flag "x" exists'),
    });
    const { user } = renderAt('/p/default/production/flags');
    await user.click(await screen.findByRole('button', { name: 'Create flag' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Key'), '-bad');
    await user.click(within(dialog).getByRole('button', { name: 'Create flag' }));
    expect(within(dialog).getByText(/must start with a letter or digit/)).toBeTruthy();

    await user.clear(within(dialog).getByLabelText('Key'));
    await user.type(within(dialog).getByLabelText('Name'), 'Theme');
    await user.type(within(dialog).getByLabelText('Key'), 'theme');
    await user.click(within(dialog).getByRole('radio', { name: 'JSON' }));
    await user.clear(within(dialog).getByLabelText('Variant 1 value'));
    await user.type(within(dialog).getByLabelText('Variant 1 value'), '{{bad');
    await user.clear(within(dialog).getByLabelText('Variant 2 name'));
    await user.type(within(dialog).getByLabelText('Variant 2 name'), 'a');
    await user.click(within(dialog).getByRole('button', { name: 'Create flag' }));
    expect(within(dialog).getByText(/Enter valid JSON/)).toBeTruthy();

    await user.clear(within(dialog).getByLabelText('Variant 1 value'));
    await user.type(within(dialog).getByLabelText('Variant 1 value'), '{{}');
    await user.click(within(dialog).getByRole('button', { name: 'Create flag' }));
    expect(within(dialog).getByText(/Duplicate variant key/)).toBeTruthy();

    await user.clear(within(dialog).getByLabelText('Variant 2 name'));
    await user.type(within(dialog).getByLabelText('Variant 2 name'), 'b');
    await user.click(within(dialog).getByRole('button', { name: 'Create flag' }));
    expect(
      await within(dialog).findByText('A flag with this key already exists in this project'),
    ).toBeTruthy();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
