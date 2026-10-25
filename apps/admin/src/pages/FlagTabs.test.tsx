import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { FlagDetail } from '../api';
import { apiError, mockApi, projects, session } from '../../test/server';
import { renderAt } from '../../test/render';

const URL = '/p/default/production/flags/banner';

function flag(version = 2, archived = false): FlagDetail {
  const config = {
    enabled: true,
    offVariant: 'a',
    prerequisites: [],
    rules: [],
    fallthrough: { variant: 'b' },
    updatedAt: '2030-01-01T00:00:00Z',
  };
  return {
    key: 'banner',
    name: 'Banner',
    description: '',
    type: 'string',
    variants: [
      { key: 'a', value: 'Hi' },
      { key: 'b', value: 'Hello' },
    ],
    clientSide: false,
    salt: 'banner',
    archived,
    version,
    createdAt: '2030-01-01T00:00:00Z',
    updatedAt: '2030-01-01T00:00:00Z',
    environments: { production: config, development: config },
  };
}

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

const entry = (id: number, action: string, diff: unknown[] = []) => ({
  id,
  at: new Date(Date.now() - id * 60_000).toISOString(),
  actor: 'Eddie',
  action,
  targetType: 'flag',
  targetKey: 'banner',
  environment: action === 'flag.config.update' ? 'production' : null,
  before: null,
  after: null,
  diff,
});

describe('flag tabs', () => {
  it('shows evaluation counts per variant and switches range', async () => {
    const api = mockApi({
      ...base(),
      'GET /api/projects/default/flags/banner': flag(),
      'GET /api/projects/default/flags/banner/exposures': (_b: unknown, url: URL) =>
        url.searchParams.get('hours') === '24'
          ? {
              from: '',
              to: '',
              totals: [
                { variant: 'b', count: 750 },
                { variant: 'a', count: 250 },
              ],
              series: [],
            }
          : { from: '', to: '', totals: [], series: [] },
    });
    const { user } = renderAt(`${URL}?tab=exposures`);
    const list = await screen.findByRole('list', { name: 'Evaluations by variant' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['b Hello750 · 75.0%', 'a Hi250 · 25.0%']);
    expect(screen.getByText(/1,000 evaluations/)).toBeTruthy();
    await user.click(screen.getByRole('radio', { name: '7 days' }));
    expect(await screen.findByText('No evaluations reported')).toBeTruthy();
    expect(api.calls.at(-1)?.path).toContain('hours=168');
  });

  it('shows history with expandable diffs and loads older entries', async () => {
    mockApi({
      ...base(),
      'GET /api/projects/default/flags/banner': flag(),
      'GET /api/projects/default/audit': (_b: unknown, url: URL) =>
        url.searchParams.get('before') === null
          ? {
              entries: [
                entry(1, 'flag.config.update', [
                  { path: 'fallthrough.variant', op: 'changed', before: 'a', after: 'b' },
                ]),
                entry(2, 'flag.kill_switch', [
                  { path: 'enabled', op: 'changed', before: false, after: true },
                ]),
              ],
              next: 2,
            }
          : { entries: [entry(3, 'flag.create')], next: null },
    });
    const { user } = renderAt(`${URL}?tab=history`);
    const list = await screen.findByRole('list', { name: 'Change history' });
    expect(within(list).getByText(/changed targeting of/)).toBeTruthy();
    expect(within(list).getByText('production')).toBeTruthy();
    const toggle = within(list).getAllByRole('button', { name: 'Show 1 change' })[0]!;
    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(within(list).getByText('Default rule › variant')).toBeTruthy();
    expect(within(list).getByLabelText('before').textContent).toBe('"a"');
    await user.click(toggle);
    expect(within(list).queryByText('Default rule › variant')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Show older changes' }));
    expect(await within(list).findByText(/created flag/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show older changes' })).toBeNull();
  });

  it('edits flag details with the version and handles conflicts', async () => {
    let current = flag();
    const api = mockApi({
      ...base(),
      'GET /api/projects/default/flags/banner': () => current,
      'PUT /api/projects/default/flags/banner': (body: unknown) => {
        const b = body as { version: number; name: string };
        if (b.version !== current.version)
          return apiError(409, 'version_conflict', 'changed', { currentVersion: current.version });
        current = { ...flag(current.version + 1), name: b.name };
        return current;
      },
    });
    const { user } = renderAt(`${URL}?tab=settings`);
    const name = await screen.findByLabelText('Name');
    expect(screen.getByRole('button', { name: 'Save details' })).toHaveProperty('disabled', true);
    await user.clear(name);
    await user.click(screen.getByRole('button', { name: 'Save details' }));
    expect(screen.getByText('Give the flag a name')).toBeTruthy();
    await user.type(name, 'Homepage banner');
    await user.click(screen.getByRole('switch', { name: /browser and mobile/ }));
    await user.click(screen.getByRole('button', { name: 'Save details' }));
    expect(await screen.findByText('Flag settings saved.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Homepage banner' })).toBeTruthy();
    expect(api.calls.find((c) => c.method === 'PUT')?.body).toEqual({
      version: 2,
      name: 'Homepage banner',
      description: '',
      clientSide: true,
    });

    current = { ...current, version: 9 };
    await user.type(screen.getByLabelText('Description'), 'x');
    await user.click(screen.getByRole('button', { name: 'Save details' }));
    expect(await screen.findByText(/Someone else changed this flag/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Reload latest' }));
    await waitFor(() => {
      expect(screen.queryByText(/Someone else changed this flag/)).toBeNull();
    });
  });

  it('archives after confirming, then restores', async () => {
    let current = flag();
    mockApi({
      ...base(),
      'GET /api/projects/default/flags/banner': () => current,
      'POST /api/projects/default/flags/banner/archive': () => (current = flag(3, true)),
      'POST /api/projects/default/flags/banner/restore': () => (current = flag(4, false)),
    });
    const { user } = renderAt(`${URL}?tab=settings`);
    await user.click(await screen.findByRole('button', { name: 'Archive flag' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Archive' }));
    expect(await screen.findByText(/This flag is archived/)).toBeTruthy();
    expect(screen.getByLabelText('Name')).toHaveProperty('disabled', true);
    await user.click(screen.getByRole('button', { name: 'Restore flag' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Restore' }));
    expect(await screen.findByText('Banner restored.')).toBeTruthy();
    expect(screen.queryByText(/This flag is archived/)).toBeNull();
  });

  it('explains why archiving was refused', async () => {
    mockApi({
      ...base(),
      'GET /api/projects/default/flags/banner': flag(),
      'POST /api/projects/default/flags/banner/archive': apiError(
        400,
        'invalid_argument',
        'this change would leave the production ruleset invalid',
        [{ path: 'flags.checkout.prerequisites[0].flag', message: 'unknown flag "banner"' }],
      ),
    });
    const { user } = renderAt(`${URL}?tab=settings`);
    await user.click(await screen.findByRole('button', { name: 'Archive flag' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Archive' }));
    expect(await screen.findByText('unknown flag "banner"')).toBeTruthy();
  });
});

describe('history page', () => {
  it('shows project history and an empty state', async () => {
    mockApi({ ...base(), 'GET /api/projects/default/audit': { entries: [], next: null } });
    renderAt('/p/default/production/history');
    expect(await screen.findByText('No changes yet')).toBeTruthy();
  });

  it('shows an error with retry', async () => {
    let fail = true;
    mockApi({
      ...base(),
      'GET /api/projects/default/audit': () =>
        fail
          ? apiError(500, 'internal', 'internal error')
          : { entries: [entry(5, 'segment.create')], next: null },
    });
    const { user } = renderAt('/p/default/production/history');
    expect(await screen.findByText('internal error')).toBeTruthy();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/created segment/)).toBeTruthy();
  });
});
