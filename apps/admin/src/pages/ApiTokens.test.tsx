import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { apiError, mockApi, projects, session } from '../../test/server';
import { renderAt } from '../../test/render';

const URL = '/p/default/production/settings';
const SECRET = `fst_${'T'.repeat(43)}`;
const editor = { ...session, user: { ...session.user, role: 'editor' } };
const viewer = { ...session, user: { ...session.user, role: 'viewer' } };

const base = {
  displayPrefix: 'fst_AbCdEfGh',
  createdAt: '2030-01-01T00:00:00Z',
  expiresAt: '2099-01-31T00:00:00Z',
  lastUsedAt: null,
  revoked: false,
  expired: false,
};

describe('API tokens in settings', () => {
  it('creates a token limited to one environment, reveals it once, and revokes it', async () => {
    let tokens: unknown[] = [];
    const api = mockApi({
      'GET /api/session': editor,
      'GET /api/projects': projects,
      'GET /api/tokens': () => ({ tokens }),
      'POST /api/tokens': (body: unknown) => {
        const b = body as Record<string, unknown>;
        const t = { id: 't1', ...base, ...b, environments: b.environments ?? null };
        tokens = [t];
        return { ...t, secret: SECRET };
      },
      'DELETE /api/tokens/t1': () => {
        tokens = [{ ...(tokens[0] as object), revoked: true }];
        return [204, null];
      },
    });
    const { user } = renderAt(URL);
    expect(await screen.findByText('No tokens yet')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Create token' }));
    const dialog = screen.getByRole('dialog', { name: 'Create API token' });

    // An editor is offered read and write scopes, but nothing that needs an admin.
    expect(within(dialog).getByRole('checkbox', { name: /Change flags/ })).toBeTruthy();
    expect(within(dialog).queryByRole('checkbox', { name: /webhooks/ })).toBeNull();

    await user.click(within(dialog).getByRole('checkbox', { name: /Read flags/ }));
    await user.click(within(dialog).getByRole('checkbox', { name: 'Production' }));
    await user.click(within(dialog).getByRole('checkbox', { name: 'Development' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create token' }));
    expect(within(dialog).getByText(/Name the token/)).toBeTruthy();
    expect(within(dialog).getByText('Pick at least one scope')).toBeTruthy();
    expect(within(dialog).getByText('Pick at least one environment')).toBeTruthy();
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);

    await user.type(within(dialog).getByLabelText('Name'), 'deploy job');
    await user.click(within(dialog).getByRole('checkbox', { name: /Read flags/ }));
    await user.click(within(dialog).getByRole('checkbox', { name: /Change flags/ }));
    await user.click(within(dialog).getByRole('checkbox', { name: 'Development' }));
    await user.selectOptions(within(dialog).getByLabelText('Expires after'), '90');
    await user.click(within(dialog).getByRole('button', { name: 'Create token' }));

    const reveal = await screen.findByRole('dialog', { name: 'Copy your new token' });
    expect(within(reveal).getByLabelText('New token').textContent).toBe(SECRET);
    await user.click(within(reveal).getByRole('button', { name: 'Copy' }));
    expect(await navigator.clipboard.readText()).toBe(SECRET);
    await user.click(within(reveal).getByRole('button', { name: "I've copied it" }));
    expect(screen.queryByText(SECRET)).toBeNull();
    expect(api.calls.find((c) => c.method === 'POST')?.body).toEqual({
      name: 'deploy job',
      scopes: ['flags:read', 'flags:write'],
      project: 'default',
      environments: ['development'],
      expiresInDays: 90,
    });

    const list = await screen.findByRole('list', { name: 'API tokens' });
    expect(within(list).getByText('default · development')).toBeTruthy();
    expect(within(list).getByText('flags:read, flags:write')).toBeTruthy();
    expect(within(list).getByText('Never used')).toBeTruthy();
    await user.click(within(list).getByRole('button', { name: 'Revoke deploy job' }));
    await user.click(screen.getByRole('button', { name: 'Revoke token' }));
    expect(await screen.findByText('Revoked deploy job.')).toBeTruthy();
    expect(await within(list).findByText('Revoked')).toBeTruthy();
    expect(within(list).queryByRole('button', { name: 'Revoke deploy job' })).toBeNull();
  });

  it('sends no project or environments for an all-projects token, and shows server errors', async () => {
    const api = mockApi({
      'GET /api/session': viewer,
      'GET /api/projects': projects,
      'GET /api/tokens': {
        tokens: [
          {
            id: 'a',
            name: 'old',
            ...base,
            scopes: ['audit:read'],
            project: null,
            environments: null,
            expired: true,
          },
          {
            id: 'b',
            name: 'reporting',
            ...base,
            scopes: ['flags:read'],
            project: 'default',
            environments: null,
            lastUsedAt: new Date().toISOString(),
          },
        ],
      },
      'POST /api/tokens': apiError(403, 'permission_denied', 'your viewer role cannot grant x'),
    });
    const { user } = renderAt(URL);
    const list = await screen.findByRole('list', { name: 'API tokens' });
    expect(within(list).getByText('All projects')).toBeTruthy();
    expect(within(list).getByText('Expired')).toBeTruthy();
    expect(within(list).getByText('default')).toBeTruthy();
    expect(within(list).getByText(/^Used /)).toBeTruthy();
    expect(within(list).getAllByRole('button', { name: /Revoke/ })).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Create token' }));
    const dialog = screen.getByRole('dialog', { name: 'Create API token' });
    // A viewer only sees read scopes.
    expect(within(dialog).queryByRole('checkbox', { name: /Change flags/ })).toBeNull();
    await user.type(within(dialog).getByLabelText('Name'), 'reports');
    await user.click(within(dialog).getByRole('radio', { name: 'All projects' }));
    expect(within(dialog).queryByRole('checkbox', { name: 'Production' })).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Create token' }));
    expect(await within(dialog).findByRole('alert')).toHaveProperty(
      'textContent',
      'your viewer role cannot grant x',
    );
    expect(api.calls.find((c) => c.method === 'POST')?.body).toEqual({
      name: 'reports',
      scopes: ['flags:read'],
      expiresInDays: 30,
    });
  });

  it('sends every environment as all environments of the project', async () => {
    const api = mockApi({
      'GET /api/session': editor,
      'GET /api/projects': projects,
      'GET /api/tokens': { tokens: [] },
      'POST /api/tokens': () => {
        throw new Error('offline');
      },
    });
    const { user } = renderAt(URL);
    await user.click(await screen.findByRole('button', { name: 'Create token' }));
    const dialog = screen.getByRole('dialog', { name: 'Create API token' });
    await user.type(within(dialog).getByLabelText('Name'), 'all envs');
    await user.click(within(dialog).getByRole('button', { name: 'Create token' }));
    expect(await within(dialog).findByRole('alert')).toBeTruthy();
    expect(api.calls.find((c) => c.method === 'POST')?.body).toEqual({
      name: 'all envs',
      scopes: ['flags:read'],
      project: 'default',
      expiresInDays: 30,
    });
  });

  it('offers a retry when the list fails to load', async () => {
    mockApi({
      'GET /api/session': editor,
      'GET /api/projects': projects,
      'GET /api/tokens': apiError(500, 'internal', 'database down'),
    });
    renderAt(URL);
    expect(await screen.findByText('database down')).toBeTruthy();
  });
});
