import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { apiError, mockApi, projects, session } from '../../test/server';
import { renderAt } from '../../test/render';

const URL = '/p/default/production/settings';
const K = '/api/projects/default/environments/production/api-keys';
const admin = { ...session, user: { ...session.user, role: 'admin' } };

const users = [
  {
    id: 'u1',
    email: 'eddie@example.com',
    name: 'Eddie',
    role: 'admin',
    disabled: false,
    createdAt: '2030-01-01T00:00:00Z',
  },
  {
    id: 'u2',
    email: 'vera@example.com',
    name: 'Vera',
    role: 'viewer',
    disabled: false,
    createdAt: '2030-01-01T00:00:00Z',
  },
];

describe('settings', () => {
  it('reveals a new key once, copies it, and revokes keys after confirming', async () => {
    let keys: unknown[] = [];
    const api = mockApi({
      'GET /api/session': admin,
      'GET /api/projects': projects,
      'GET /api/users': { users },
      [`GET ${K}`]: () => ({ keys }),
      [`POST ${K}`]: (body: unknown) => {
        const k = {
          id: 'k1',
          ...(body as object),
          displayPrefix: 'fsc_AbCdEfGh',
          createdAt: '2030-01-01T00:00:00Z',
          lastUsedAt: null,
          revoked: false,
        };
        keys = [k];
        return { ...k, secret: `fsc_${'A'.repeat(43)}` };
      },
      [`DELETE ${K}/k1`]: () => {
        keys = [{ ...(keys[0] as object), revoked: true }];
        return [204, null];
      },
    });
    const { user } = renderAt(URL);
    expect(await screen.findByText('No keys yet')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Create key' }));
    const dialog = screen.getByRole('dialog', { name: 'Create SDK key' });
    await user.click(within(dialog).getByRole('button', { name: 'Create key' }));
    expect(within(dialog).getByText(/Name the key/)).toBeTruthy();
    await user.click(within(dialog).getByRole('radio', { name: 'Client (browser)' }));
    await user.type(within(dialog).getByLabelText('Name'), 'storefront');
    await user.click(within(dialog).getByRole('button', { name: 'Create key' }));

    const reveal = await screen.findByRole('dialog', { name: 'Copy your new key' });
    expect(within(reveal).getByLabelText('New key').textContent).toBe(`fsc_${'A'.repeat(43)}`);
    await user.click(within(reveal).getByRole('button', { name: 'Copy' }));
    expect(await navigator.clipboard.readText()).toBe(`fsc_${'A'.repeat(43)}`);
    expect(await screen.findByText('Key copied.')).toBeTruthy();
    await user.click(within(reveal).getByRole('button', { name: "I've copied it" }));
    expect(screen.queryByText(`fsc_${'A'.repeat(43)}`)).toBeNull();
    expect(api.calls.find((c) => c.method === 'POST')?.body).toEqual({
      kind: 'client',
      name: 'storefront',
    });

    const list = await screen.findByRole('list', { name: 'SDK keys' });
    expect(within(list).getByText('Client')).toBeTruthy();
    expect(within(list).getByText('Never used')).toBeTruthy();
    await user.click(within(list).getByRole('button', { name: 'Revoke' }));
    await user.click(screen.getByRole('button', { name: 'Revoke key' }));
    expect(await screen.findByText('Revoked storefront.')).toBeTruthy();
    expect(
      await within(screen.getByRole('list', { name: 'SDK keys' })).findByText('Revoked'),
    ).toBeTruthy();
  });

  it('manages people: role changes, disabling and adding', async () => {
    const api = mockApi({
      'GET /api/session': admin,
      'GET /api/projects': projects,
      'GET /api/users': { users },
      [`GET ${K}`]: { keys: [] },
      'PATCH /api/users/u2': (body: unknown) => ({ ...users[1], ...(body as object) }),
      'POST /api/users': (body: unknown) => {
        const b = body as { email: string };
        if (b.email === 'vera@example.com') return apiError(409, 'already_exists', 'exists');
        return { id: 'u3', ...(body as object), disabled: false, createdAt: '' };
      },
    });
    const { user } = renderAt(URL);
    const people = await screen.findByRole('list', { name: 'People' });
    expect(within(people).getByLabelText('Role for Eddie')).toHaveProperty('disabled', true);
    await user.selectOptions(within(people).getByLabelText('Role for Vera'), 'editor');
    expect(await screen.findByText('Updated Vera.')).toBeTruthy();
    const switches = within(people).getAllByRole('switch');
    await user.click(switches[1]!);
    await waitFor(() => {
      expect(api.calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([
        { role: 'editor' },
        { disabled: true },
      ]);
    });

    await user.click(screen.getByRole('button', { name: 'Add person' }));
    const dialog = screen.getByRole('dialog', { name: 'Add person' });
    await user.click(within(dialog).getByRole('button', { name: 'Add person' }));
    expect(within(dialog).getByText('Enter an email address')).toBeTruthy();
    expect(within(dialog).getByText('Use at least 12 characters')).toBeTruthy();
    await user.type(within(dialog).getByLabelText('Email'), 'vera@example.com');
    await user.type(within(dialog).getByLabelText('Name'), 'Vera');
    await user.type(
      within(dialog).getByLabelText('Temporary password'),
      'a long temporary password',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Add person' }));
    expect(
      await within(dialog).findByText('Someone with this email already has access'),
    ).toBeTruthy();
    await user.clear(within(dialog).getByLabelText('Email'));
    await user.type(within(dialog).getByLabelText('Email'), 'nina@example.com');
    await user.click(within(dialog).getByRole('radio', { name: 'Viewer' }));
    await user.click(within(dialog).getByRole('button', { name: 'Add person' }));
    expect(await screen.findByText(/Added Vera/)).toBeTruthy();
    expect(api.calls.filter((c) => c.method === 'POST').at(-1)?.body).toMatchObject({
      role: 'viewer',
      email: 'nina@example.com',
    });
  });

  it('reports a failed update', async () => {
    mockApi({
      'GET /api/session': admin,
      'GET /api/projects': projects,
      'GET /api/users': { users },
      [`GET ${K}`]: { keys: [] },
      'PATCH /api/users/u2': apiError(400, 'invalid_argument', 'not allowed'),
    });
    const { user } = renderAt(URL);
    await user.selectOptions(await screen.findByLabelText('Role for Vera'), 'admin');
    expect(await screen.findByText('not allowed')).toBeTruthy();
  });

  it('adds an environment', async () => {
    const reload = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { href: window.location.href, reload },
      configurable: true,
    });
    const api = mockApi({
      'GET /api/session': admin,
      'GET /api/projects': projects,
      'GET /api/users': { users },
      [`GET ${K}`]: { keys: [] },
      'POST /api/projects/default/environments': (body: unknown) => {
        const b = body as { key: string };
        return b.key === 'production' ? apiError(409, 'already_exists', 'exists') : body;
      },
    });
    const { user } = renderAt(URL);
    await user.click(await screen.findByRole('button', { name: 'Add environment' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Add environment' }));
    expect(within(dialog).getByText(/Name the environment/)).toBeTruthy();
    await user.type(within(dialog).getByLabelText('Name'), 'Production');
    await user.click(within(dialog).getByRole('button', { name: 'Add environment' }));
    expect(await within(dialog).findByText('That environment already exists')).toBeTruthy();
    await user.clear(within(dialog).getByLabelText('Name'));
    await user.type(within(dialog).getByLabelText('Name'), 'Staging');
    await user.click(within(dialog).getByRole('button', { name: 'Add environment' }));
    await waitFor(() => {
      expect(reload).toHaveBeenCalled();
    });
    expect(api.calls.at(-1)?.body).toEqual({ key: 'staging', name: 'Staging' });
  });

  it('tells non-admins what they cannot manage', async () => {
    mockApi({ 'GET /api/session': session, 'GET /api/projects': projects });
    renderAt(URL);
    expect(await screen.findByText('Only admins can manage SDK keys and users.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add environment' })).toBeNull();
  });
});
