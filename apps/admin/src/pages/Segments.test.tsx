import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { apiError, mockApi, projects, session } from '../../test/server';
import { renderAt } from '../../test/render';

const URL = '/p/default/production/segments';
const S = '/api/projects/default/environments/production/segments';

const beta = {
  key: 'beta',
  name: 'Beta testers',
  description: '',
  included: ['alice', 'bob'],
  excluded: [],
  rules: [
    { id: 'r1', clauses: [{ attribute: 'email', operator: 'endsWith', values: ['@acme.com'] }] },
  ],
  version: 2,
  updatedAt: new Date().toISOString(),
};

describe('segments', () => {
  it('creates a segment with members and a rule', async () => {
    let segments: unknown[] = [];
    const api = mockApi({
      'GET /api/session': session,
      'GET /api/projects': projects,
      [`GET ${S}`]: () => ({ segments }),
      [`POST ${S}`]: (body: unknown) => {
        segments = [{ ...(body as object), version: 1, updatedAt: new Date().toISOString() }];
        return segments[0];
      },
    });
    const { user } = renderAt(URL);
    expect(await screen.findByText('No segments yet')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Create segment' }));
    const dialog = screen.getByRole('dialog', { name: 'Create segment' });
    await user.click(within(dialog).getByRole('button', { name: 'Create segment' }));
    expect(within(dialog).getByText('Give the segment a name')).toBeTruthy();
    await user.type(within(dialog).getByLabelText('Name'), 'Staff');
    expect(within(dialog).getByLabelText<HTMLInputElement>('Key').value).toBe('staff');
    await user.type(within(dialog).getByLabelText('Always include'), 'alice\nbob, alice\n\n');
    await user.type(within(dialog).getByLabelText('Always exclude'), 'mallory');
    await user.click(within(dialog).getByRole('button', { name: 'Add rule' }));
    const rule = within(dialog).getByRole('group', { name: 'Segment rule 1' });
    expect(within(rule).queryByRole('option', { name: 'is in segment' })).toBeNull();
    await user.clear(within(rule).getByLabelText('Values'));
    await user.type(within(rule).getByLabelText('Values'), '@acme.com');
    await user.click(within(rule).getByRole('button', { name: 'Add condition' }));
    await user.click(within(rule).getByRole('button', { name: 'Remove condition 2' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create segment' }));
    expect(await screen.findByText('Created Staff.')).toBeTruthy();
    expect(api.calls.find((c) => c.method === 'POST')?.body).toEqual({
      key: 'staff',
      name: 'Staff',
      description: '',
      included: ['alice', 'bob'],
      excluded: ['mallory'],
      rules: [
        {
          id: expect.any(String),
          clauses: [{ attribute: 'email', operator: 'endsWith', values: ['@acme.com'] }],
        },
      ],
    });
    const list = await screen.findByRole('list', { name: 'Segments' });
    expect(within(list).getByText('2 included · 1 rule')).toBeTruthy();
  });

  it('validates patterns and reports duplicates', async () => {
    mockApi({
      'GET /api/session': session,
      'GET /api/projects': projects,
      [`GET ${S}`]: { segments: [] },
      [`POST ${S}`]: apiError(409, 'already_exists', 'segment exists'),
    });
    const { user } = renderAt(URL);
    await user.click(await screen.findByRole('button', { name: 'Create segment' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Beta');
    await user.click(within(dialog).getByRole('button', { name: 'Add rule' }));
    const rule = within(dialog).getByRole('group', { name: 'Segment rule 1' });
    await user.selectOptions(within(rule).getByLabelText('Operator'), 'matches');
    await user.clear(within(rule).getByLabelText('Values'));
    await user.type(within(rule).getByLabelText('Values'), '(x');
    await user.click(within(dialog).getByRole('button', { name: 'Create segment' }));
    expect(within(dialog).getByText(/missing "\)"/)).toBeTruthy();
    await user.click(within(rule).getByRole('button', { name: 'Delete segment rule 1' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create segment' }));
    expect(await within(dialog).findByText('A segment with this key exists')).toBeTruthy();
  });

  it('edits with the version, shows history, and explains a refused delete', async () => {
    const api = mockApi({
      'GET /api/session': session,
      'GET /api/projects': projects,
      [`GET ${S}`]: { segments: [beta] },
      [`PUT ${S}/beta`]: (body: unknown) => ({ ...beta, ...(body as object), version: 3 }),
      [`DELETE ${S}/beta`]: apiError(
        400,
        'invalid_argument',
        'this change would leave the production ruleset invalid',
        [
          {
            path: 'flags.checkout.rules[0].clauses[0].segments[0]',
            message: 'unknown segment "beta"',
          },
        ],
      ),
      'GET /api/projects/default/audit': { entries: [], next: null },
    });
    const { user } = renderAt(URL);
    await user.click(await screen.findByRole('button', { name: /Beta testers/ }));
    const dialog = screen.getByRole('dialog', { name: 'Beta testers' });
    expect(within(dialog).getByLabelText('Key')).toHaveProperty('disabled', true);
    await user.type(within(dialog).getByLabelText('Always include'), '\ncarol');
    await user.click(within(dialog).getByRole('button', { name: 'Save segment' }));
    await waitFor(() => {
      expect(api.calls.some((c) => c.method === 'PUT')).toBe(true);
    });
    expect(api.calls.find((c) => c.method === 'PUT')?.body).toMatchObject({
      version: 2,
      included: ['alice', 'bob', 'carol'],
    });

    await user.click(await screen.findByRole('button', { name: /Beta testers/ }));
    const again = screen.getByRole('dialog', { name: 'Beta testers' });
    await user.click(within(again).getByRole('tab', { name: 'History' }));
    expect(await within(again).findByText('No changes yet')).toBeTruthy();
    await user.click(within(again).getByRole('tab', { name: 'Members and rules' }));
    await user.click(within(again).getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Delete segment' }));
    expect(await screen.findByText('unknown segment "beta"')).toBeTruthy();
  });

  it('deletes a segment no flag uses', async () => {
    let segments = [beta];
    mockApi({
      'GET /api/session': session,
      'GET /api/projects': projects,
      [`GET ${S}`]: () => ({ segments }),
      [`DELETE ${S}/beta`]: () => {
        segments = [];
        return [204, null];
      },
    });
    const { user } = renderAt(URL);
    await user.click(await screen.findByRole('button', { name: /Beta testers/ }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Delete segment' }));
    expect(await screen.findByText('Deleted Beta testers.')).toBeTruthy();
    expect(await screen.findByText('No segments yet')).toBeTruthy();
  });

  it('is read-only for viewers', async () => {
    mockApi({
      'GET /api/session': { ...session, user: { ...session.user, role: 'viewer' } },
      'GET /api/projects': projects,
      [`GET ${S}`]: { segments: [beta] },
    });
    const { user } = renderAt(URL);
    expect(screen.queryByRole('button', { name: 'Create segment' })).toBeNull();
    await user.click(await screen.findByRole('button', { name: /Beta testers/ }));
    expect(within(screen.getByRole('dialog')).getByLabelText('Name')).toHaveProperty(
      'disabled',
      true,
    );
    expect(
      within(screen.getByRole('dialog')).queryByRole('button', { name: 'Save segment' }),
    ).toBeNull();
  });

  it('shows a load error', async () => {
    mockApi({
      'GET /api/session': session,
      'GET /api/projects': projects,
      [`GET ${S}`]: apiError(500, 'internal', 'internal error'),
    });
    renderAt(URL);
    expect(await screen.findByText('internal error')).toBeTruthy();
  });
});
