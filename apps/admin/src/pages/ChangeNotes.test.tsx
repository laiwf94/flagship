import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ChangeRequest } from '../api';
import { apiError, mockApi, projects, session } from '../../test/server';
import { renderAt } from '../../test/render';

const P = '/api/projects/default';
const FLAG_URL = '/p/default/production/flags/new-checkout';
const ENV_API = `${P}/flags/new-checkout/environments/production`;
const ID = '11111111-2222-4333-8444-555555555555';

/** Production asks every change for a reason and a link; development asks nothing. */
function withPolicy(production: Record<string, unknown>) {
  return {
    projects: [
      {
        ...projects.projects[0],
        environments: [
          { key: 'development', name: 'Development' },
          { key: 'production', name: 'Production', ...production },
        ],
      },
    ],
  };
}
const strict = withPolicy({ requireReason: true, requireLink: true });

const config = {
  enabled: true,
  offVariant: 'off',
  prerequisites: [],
  rules: [],
  fallthrough: { variant: 'off' },
  updatedAt: '2030-01-01T00:00:00Z',
};
const flag = {
  key: 'new-checkout',
  name: 'New checkout',
  description: '',
  type: 'boolean',
  variants: [
    { key: 'on', value: true },
    { key: 'off', value: false },
  ],
  clientSide: false,
  salt: 'new-checkout',
  archived: false,
  version: 2,
  createdAt: '2030-01-01T00:00:00Z',
  updatedAt: '2030-01-01T00:00:00Z',
  environments: { production: { ...config, version: 5 }, development: { ...config, version: 1 } },
};
const ruleset = { environment: 'production', version: 3, flags: {}, segments: {} };

const notes = (c: { headers: Record<string, string> }) => ({
  reason: c.headers['flagship-reason'],
  link: c.headers['flagship-link'],
});

function flagApi(projectList: unknown, extra: Record<string, unknown> = {}) {
  return mockApi({
    'GET /api/session': session,
    'GET /api/projects': projectList,
    [`GET ${P}/flags/new-checkout`]: flag,
    [`GET ${P}/environments/production/ruleset`]: ruleset,
    [`PUT ${ENV_API}`]: (b: unknown) => ({
      ...flag,
      environments: { ...flag.environments, production: { ...(b as object), version: 6 } },
    }),
    [`POST ${ENV_API}/kill-switch`]: (b: unknown) => ({
      ...flag,
      environments: {
        ...flag.environments,
        production: { ...config, ...(b as object), version: 6 },
      },
    }),
    ...extra,
  });
}

describe('reasons and links in the editors', () => {
  it('asks for a reason and link before saving targeting, and sends them as headers', async () => {
    const api = flagApi(strict);
    const { user } = renderAt(FLAG_URL);
    await user.selectOptions(
      await screen.findByLabelText('Serve when off or a prerequisite fails'),
      'on',
    );
    await user.click(screen.getByRole('button', { name: 'Review and save' }));
    const dialog = screen.getByRole('dialog', { name: /Review changes to New checkout/ });
    expect(within(dialog).getByText(/Production asks why for every change/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Save to Production' }));
    expect(within(dialog).getByText('Production needs a reason for every change')).toBeTruthy();
    expect(
      within(dialog).getByText('Production needs a ticket link for every change'),
    ).toBeTruthy();
    expect(within(dialog).getByLabelText('Reason').getAttribute('aria-invalid')).toBe('true');
    expect(api.calls.some((c) => c.method === 'PUT')).toBe(false);

    await user.type(within(dialog).getByLabelText('Reason'), 'Roll back: 50% café errors');
    await user.type(within(dialog).getByLabelText('Ticket link'), 'not a link');
    await user.click(within(dialog).getByRole('button', { name: 'Save to Production' }));
    expect(within(dialog).getByText('Enter a link that starts with https://')).toBeTruthy();
    await user.clear(within(dialog).getByLabelText('Ticket link'));
    await user.type(within(dialog).getByLabelText('Ticket link'), 'https://t.example/INC-42');
    await user.click(within(dialog).getByRole('button', { name: 'Save to Production' }));

    expect(await screen.findByText('Saved targeting for New checkout in Production.')).toBeTruthy();
    const put = api.calls.find((c) => c.method === 'PUT');
    expect(put === undefined ? undefined : notes(put)).toEqual({
      reason: encodeURIComponent('Roll back: 50% café errors'),
      link: 'https://t.example/INC-42',
    });
    expect(decodeURIComponent(put?.headers['flagship-reason'] ?? '')).toBe(
      'Roll back: 50% café errors',
    );
  });

  it('marks the fields optional and sends no headers where nothing is required', async () => {
    const api = flagApi(projects);
    const { user } = renderAt(FLAG_URL);
    await user.selectOptions(
      await screen.findByLabelText('Serve when off or a prerequisite fails'),
      'on',
    );
    await user.click(screen.getByRole('button', { name: 'Review and save' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('Reason (optional)')).toBeTruthy();
    expect(within(dialog).getByLabelText('Ticket link (optional)')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Save to Production' }));
    expect(await screen.findByText('Saved targeting for New checkout in Production.')).toBeTruthy();
    const put = api.calls.find((c) => c.method === 'PUT');
    expect(put?.headers['flagship-reason']).toBeUndefined();
    expect(put?.headers['flagship-link']).toBeUndefined();
  });

  it('shows the server refusing a missing note at the field', async () => {
    flagApi(projects, {
      [`PUT ${ENV_API}`]: apiError(400, 'invalid_argument', 'changes in production need a reason', [
        { path: 'header.flagship-reason', message: 'required in production' },
      ]),
    });
    const { user } = renderAt(FLAG_URL);
    await user.selectOptions(
      await screen.findByLabelText('Serve when off or a prerequisite fails'),
      'on',
    );
    await user.click(screen.getByRole('button', { name: 'Review and save' }));
    await user.click(screen.getByRole('button', { name: 'Save to Production' }));
    expect(await screen.findByText('Reason required in production')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('needs a note for the kill switch and carries it to the undo', async () => {
    const api = flagApi(withPolicy({ requireReason: true }));
    const { user } = renderAt(FLAG_URL);
    await user.click(await screen.findByRole('switch', { name: 'On in Production' }));
    const dialog = screen.getByRole('dialog', { name: 'Turn off New checkout in Production?' });
    expect(within(dialog).getByLabelText('Reason')).toBe(document.activeElement);
    expect(within(dialog).getByLabelText('Ticket link (optional)')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Turn off' }));
    expect(within(dialog).getByText('Production needs a reason for every change')).toBeTruthy();
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);

    await user.type(within(dialog).getByLabelText('Reason'), 'Checkout errors spiking');
    await user.click(within(dialog).getByRole('button', { name: 'Turn off' }));
    expect(await screen.findByRole('switch', { name: 'Off in Production' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => {
      expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(2);
    });
    expect(api.calls.filter((c) => c.method === 'POST').map(notes)).toEqual([
      { reason: 'Checkout%20errors%20spiking', link: undefined },
      { reason: 'Checkout%20errors%20spiking', link: undefined },
    ]);
  });

  it('keeps the kill switch dialog open when the server wants a note', async () => {
    flagApi(projects, {
      [`POST ${ENV_API}/kill-switch`]: apiError(400, 'invalid_argument', 'need a link', [
        { path: 'header.flagship-link', message: 'required in production' },
      ]),
    });
    const { user } = renderAt(FLAG_URL);
    await user.click(await screen.findByRole('switch', { name: 'On in Production' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Turn off' })).toBe(document.activeElement);
    await user.click(within(dialog).getByRole('button', { name: 'Turn off' }));
    expect(await within(dialog).findByText('Ticket link required in production')).toBeTruthy();
  });

  it('asks a change request only for the link, since its title is the reason', async () => {
    let created: ChangeRequest | undefined;
    const api = flagApi(
      withPolicy({ requiredApprovals: 1, requireReason: true, requireLink: true }),
      {
        [`POST ${ENV_API}/change-requests`]: (b: unknown) => {
          created = {
            id: ID,
            target: 'flag',
            flag: 'new-checkout',
            segment: null,
            environment: 'production',
            title: (b as { title: string }).title,
            description: '',
            status: 'open',
            revision: 1,
            author: 'Eddie',
            authorId: 'u1',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            finishedAt: null,
            finishedBy: null,
            baseVersion: 5,
            base: null,
            proposed: null,
            diff: [],
            approvals: { required: 1, approvedBy: [], changesRequestedBy: [] },
            live: { version: 5, stale: false, changedSinceBase: [], conflicts: [] },
            canApply: false,
            reviews: [],
            reason: null,
            link: 'https://t.example/CHG-7',
          };
          return [201, created];
        },
        [`GET ${P}/change-requests/${ID}`]: () => created,
      },
    );
    const { user } = renderAt(FLAG_URL);
    await user.selectOptions(
      await screen.findByLabelText('Serve when off or a prerequisite fails'),
      'on',
    );
    await user.click(screen.getByRole('button', { name: 'Review and request approval' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByLabelText('Reason')).toBeNull();
    expect(within(dialog).getByText(/The title is recorded as the reason/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Open change request' }));
    expect(
      within(dialog).getByText('Production needs a ticket link for every change'),
    ).toBeTruthy();
    await user.type(within(dialog).getByLabelText('Ticket link'), 'https://t.example/CHG-7');
    await user.click(within(dialog).getByRole('button', { name: 'Open change request' }));
    expect(
      await screen.findByRole('heading', { name: 'Change targeting of New checkout', level: 1 }),
    ).toBeTruthy();
    const post = api.calls.find((c) => c.method === 'POST');
    expect(post === undefined ? undefined : notes(post)).toEqual({
      reason: undefined,
      link: 'https://t.example/CHG-7',
    });
    // The review page shows the link the request was proposed with.
    expect(screen.getByRole('link', { name: 'https://t.example/CHG-7' })).toBeTruthy();
  });

  it('asks for a note when scheduling a change', async () => {
    const S = `${ENV_API}/schedules`;
    const api = flagApi(withPolicy({ requireLink: true }), {
      [`GET ${S}`]: { schedules: [] },
      [`POST ${S}`]: (b: unknown) => ({
        id: 'sch1',
        status: 'pending',
        error: null,
        createdBy: 'Eddie',
        ...(b as object),
      }),
    });
    const { user } = renderAt(`${FLAG_URL}?tab=schedules`);
    await user.click(await screen.findByRole('button', { name: 'Schedule a change' }));
    const dialog = screen.getByRole('dialog', { name: 'Schedule a change' });
    fireEvent.change(within(dialog).getByLabelText('When'), {
      target: { value: '2099-01-01T10:00' },
    });
    await user.click(within(dialog).getByRole('button', { name: 'Schedule' }));
    expect(
      within(dialog).getByText('Production needs a ticket link for every change'),
    ).toBeTruthy();
    await user.type(within(dialog).getByLabelText('Reason (optional)'), 'Launch day');
    await user.type(within(dialog).getByLabelText('Ticket link'), 'https://t.example/L-1');
    await user.click(within(dialog).getByRole('button', { name: 'Schedule' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    const post = api.calls.find((c) => c.method === 'POST');
    expect(post === undefined ? undefined : notes(post)).toEqual({
      reason: 'Launch%20day',
      link: 'https://t.example/L-1',
    });
  });

  it('shows a scheduling refusal for a missing note at the field', async () => {
    const S = `${ENV_API}/schedules`;
    flagApi(projects, {
      [`GET ${S}`]: { schedules: [] },
      [`POST ${S}`]: apiError(400, 'invalid_argument', 'need a reason', [
        { path: 'header.flagship-reason', message: 'required in production' },
      ]),
    });
    const { user } = renderAt(`${FLAG_URL}?tab=schedules`);
    await user.click(await screen.findByRole('button', { name: 'Schedule a change' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Schedule' }));
    expect(await within(dialog).findByText('Reason required in production')).toBeTruthy();
  });
});

describe('reasons and links for segments', () => {
  const S = `${P}/environments/production/segments`;
  const beta = {
    key: 'beta',
    name: 'Beta testers',
    description: '',
    included: ['alice'],
    excluded: [],
    rules: [],
    version: 4,
    updatedAt: '2030-01-01T00:00:00Z',
  };

  it('sends the note with a create, an edit and a delete', async () => {
    let segments = [beta];
    const api = mockApi({
      'GET /api/session': session,
      'GET /api/projects': strict,
      [`GET ${S}`]: () => ({ segments }),
      [`POST ${S}`]: (b: unknown) => [201, { ...(b as object), version: 1 }],
      [`PUT ${S}/beta`]: (b: unknown) => ({ ...beta, ...(b as object), version: 5 }),
      [`DELETE ${S}/beta`]: () => {
        segments = [];
        return [204, null];
      },
    });
    const { user } = renderAt('/p/default/production/segments');
    await user.click(await screen.findByRole('button', { name: 'Create segment' }));
    let dialog = screen.getByRole('dialog', { name: 'Create segment' });
    await user.type(within(dialog).getByLabelText('Name'), 'Staff');
    await user.click(within(dialog).getByRole('button', { name: 'Create segment' }));
    expect(within(dialog).getByText('Production needs a reason for every change')).toBeTruthy();
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
    await user.type(within(dialog).getByLabelText('Reason'), 'Staff dogfooding');
    await user.type(within(dialog).getByLabelText('Ticket link'), 'https://t.example/S-1');
    await user.click(within(dialog).getByRole('button', { name: 'Create segment' }));
    expect(await screen.findByText('Created Staff.')).toBeTruthy();

    await user.click(await screen.findByRole('button', { name: /Beta testers/ }));
    dialog = screen.getByRole('dialog', { name: 'Beta testers' });
    await user.type(within(dialog).getByLabelText('Reason'), 'Add bob');
    await user.type(within(dialog).getByLabelText('Ticket link'), 'https://t.example/S-2');
    await user.click(within(dialog).getByRole('button', { name: 'Save segment' }));
    expect(await screen.findByText('Saved Beta testers.')).toBeTruthy();

    await user.click(await screen.findByRole('button', { name: /Beta testers/ }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    const confirm = screen.getByRole('dialog', { name: 'Delete Beta testers?' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete segment' }));
    expect(within(confirm).getByText('Production needs a reason for every change')).toBeTruthy();
    await user.type(within(confirm).getByLabelText('Reason'), 'Unused');
    await user.type(within(confirm).getByLabelText('Ticket link'), 'https://t.example/S-3');
    await user.click(within(confirm).getByRole('button', { name: 'Delete segment' }));
    expect(await screen.findByText('Deleted Beta testers.')).toBeTruthy();

    expect(api.calls.filter((c) => c.method !== 'GET').map((c) => [c.method, notes(c)])).toEqual([
      ['POST', { reason: 'Staff%20dogfooding', link: 'https://t.example/S-1' }],
      ['PUT', { reason: 'Add%20bob', link: 'https://t.example/S-2' }],
      ['DELETE', { reason: 'Unused', link: 'https://t.example/S-3' }],
    ]);
  });

  it('asks a protected segment change only for the link', async () => {
    const api = mockApi({
      'GET /api/session': session,
      'GET /api/projects': withPolicy({
        requiredApprovals: 1,
        requireReason: true,
        requireLink: true,
      }),
      [`GET ${S}`]: { segments: [beta] },
      [`POST ${S}/beta/change-requests`]: apiError(400, 'invalid_argument', 'need a link', [
        { path: 'header.flagship-link', message: 'required in production' },
      ]),
    });
    const { user } = renderAt('/p/default/production/segments');
    await user.click(await screen.findByRole('button', { name: /Beta testers/ }));
    const dialog = screen.getByRole('dialog', { name: 'Beta testers' });
    expect(within(dialog).queryByLabelText('Reason')).toBeNull();
    await user.type(within(dialog).getByLabelText('Ticket link'), 'https://t.example/S-9');
    await user.click(within(dialog).getByRole('button', { name: 'Request approval' }));
    // The server's answer lands on the field, not in a generic banner.
    expect(await within(dialog).findByText('Ticket link required in production')).toBeTruthy();
    expect(within(dialog).queryByRole('alert')).toBeNull();
    const post = api.calls.find((c) => c.method === 'POST');
    expect(post === undefined ? undefined : notes(post)).toEqual({
      reason: undefined,
      link: 'https://t.example/S-9',
    });
  });
});

describe('change rules in settings', () => {
  const admin = { ...session, user: { ...session.user, role: 'admin' } };

  it('shows each environment rules and lets an admin change them', async () => {
    let list = withPolicy({ requiredApprovals: 2, requireReason: true });
    const api = mockApi({
      'GET /api/session': admin,
      'GET /api/projects': () => list,
      'GET /api/users': { users: [] },
      [`GET ${P}/environments/production/api-keys`]: { keys: [] },
      [`PUT ${P}/environments/production/change-notes`]: (b: unknown) => {
        list = withPolicy({ requiredApprovals: 2, ...(b as object) });
        return { key: 'production', name: 'Production', requiredApprovals: 2, ...(b as object) };
      },
    });
    const { user } = renderAt('/p/default/production/settings');
    const envs = await screen.findByRole('list', { name: 'Environments' });
    const prod = within(envs).getByText('Production').closest('li') as HTMLElement;
    expect(within(prod).getByText('2 approvals')).toBeTruthy();
    expect(within(prod).getByText('Reason required')).toBeTruthy();
    expect(within(prod).queryByText('Ticket link required')).toBeNull();

    await user.click(within(prod).getByRole('button', { name: 'Change rules for Production' }));
    const dialog = screen.getByRole('dialog', { name: 'Change rules for Production' });
    const save = within(dialog).getByRole('button', { name: 'Save rules' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(
      within(dialog).getByRole('switch', { name: 'Require a reason' }).getAttribute('aria-checked'),
    ).toBe('true');
    await user.click(within(dialog).getByRole('switch', { name: 'Require a ticket link' }));
    await user.click(save);
    expect(await screen.findByText('Saved the change rules for Production.')).toBeTruthy();
    expect(api.calls.find((c) => c.method === 'PUT')?.body).toEqual({
      requireReason: true,
      requireLink: true,
    });
    // The project listing is loaded again, so the badges and every editor see the new rule.
    expect(await within(envs).findByText('Ticket link required')).toBeTruthy();
  });

  it('reports a failed save and hides the control from non-admins', async () => {
    mockApi({
      'GET /api/session': { ...session, user: { ...session.user, role: 'admin' } },
      'GET /api/projects': projects,
      'GET /api/users': { users: [] },
      [`GET ${P}/environments/production/api-keys`]: { keys: [] },
      [`PUT ${P}/environments/development/change-notes`]: apiError(
        403,
        'permission_denied',
        'admins only',
      ),
    });
    const { user } = renderAt('/p/default/production/settings');
    await user.click(await screen.findByRole('button', { name: 'Change rules for Development' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('switch', { name: 'Require a reason' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save rules' }));
    expect(await within(dialog).findByText('admins only')).toBeTruthy();
  });

  it('shows the rules read-only to editors', async () => {
    mockApi({
      'GET /api/session': session,
      'GET /api/projects': strict,
    });
    renderAt('/p/default/production/settings');
    expect(await screen.findByText('Ticket link required')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Change rules/ })).toBeNull();
  });
});

describe('history search', () => {
  const entry = (id: number, over: Record<string, unknown> = {}) => ({
    id,
    at: '2026-11-06T09:00:00Z',
    actor: 'Ana Lima',
    action: 'flag.kill_switch',
    targetType: 'flag',
    targetKey: 'new-checkout',
    environment: 'production',
    reason: 'Checkout errors',
    link: 'https://t.example/INC-42',
    diff: [],
    ...over,
  });

  it('filters by text, actor and days, keeps them in the address and clears them', async () => {
    const api = mockApi({
      'GET /api/session': session,
      'GET /api/projects': projects,
      [`GET ${P}/audit`]: (_b: unknown, url: URL) =>
        url.searchParams.has('q')
          ? { entries: [entry(2)], next: 'c2' }
          : url.searchParams.has('cursor')
            ? { entries: [entry(1, { reason: 'Older one' })], next: null }
            : { entries: [entry(3, { reason: 'Unfiltered' })], next: null },
    });
    const { user, router } = renderAt('/p/default/production/history');
    expect(await screen.findByText('Unfiltered')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();

    const form = screen.getByRole('search', { name: 'Search history' });
    await user.type(within(form).getByLabelText('Search'), 'INC-42');
    await user.type(within(form).getByLabelText('Changed by'), 'Ana Lima');
    fireEvent.change(within(form).getByLabelText('From'), { target: { value: '2026-11-01' } });
    fireEvent.change(within(form).getByLabelText('To'), { target: { value: '2026-11-07' } });
    await user.click(within(form).getByRole('button', { name: 'Search' }));

    expect(await screen.findByText('Checkout errors')).toBeTruthy();
    expect(router.state.location.search).toBe(
      '?q=INC-42&actor=Ana+Lima&from=2026-11-01&to=2026-11-07',
    );
    const searched = api.calls.filter((c) => c.path.includes('q=INC-42'));
    const q = new URL(`http://x${searched[0]?.path ?? ''}`).searchParams;
    expect(Object.fromEntries(q)).toEqual({
      q: 'INC-42',
      actor: 'Ana Lima',
      from: new Date(2026, 10, 1).toISOString(),
      to: new Date(2026, 10, 8).toISOString(),
      limit: '25',
    });

    // Older pages keep the same filters.
    await user.click(screen.getByRole('button', { name: 'Show older changes' }));
    await waitFor(() => {
      expect(api.calls.some((c) => c.path.includes('cursor=c2'))).toBe(true);
    });
    const older = api.calls.find((c) => c.path.includes('cursor=c2'));
    expect(older?.path).toContain('actor=Ana+Lima');

    await user.click(within(form).getByRole('button', { name: 'Clear' }));
    expect(await screen.findByText('Unfiltered')).toBeTruthy();
    expect(router.state.location.search).toBe('');
    expect(within(form).getByLabelText<HTMLInputElement>('Search').value).toBe('');
  });

  it('loads filters from the address and says when nothing matches', async () => {
    const api = mockApi({
      'GET /api/session': session,
      'GET /api/projects': projects,
      [`GET ${P}/audit`]: { entries: [], next: null },
    });
    renderAt('/p/default/production/history?actor=Nobody');
    expect(await screen.findByText('No changes match')).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Changed by').value).toBe('Nobody');
    expect(api.calls.find((c) => c.path.includes('/audit'))?.path).toContain('actor=Nobody');
  });

  it('refuses a backwards range without searching', async () => {
    const api = mockApi({
      'GET /api/session': session,
      'GET /api/projects': projects,
      [`GET ${P}/audit`]: { entries: [entry(1)], next: null },
    });
    const { user, router } = renderAt('/p/default/production/history');
    const form = await screen.findByRole('search');
    await screen.findByText('Checkout errors');
    fireEvent.change(within(form).getByLabelText('From'), { target: { value: '2026-11-08' } });
    fireEvent.change(within(form).getByLabelText('To'), { target: { value: '2026-11-07' } });
    await user.click(within(form).getByRole('button', { name: 'Search' }));
    expect(within(form).getByText('Pick a day on or after the first')).toBeTruthy();
    expect(router.state.location.search).toBe('');
    expect(api.calls.filter((c) => c.path.includes('/audit'))).toHaveLength(1);
  });

  it('shows the problem for a bad range typed into the address', async () => {
    const api = mockApi({
      'GET /api/session': session,
      'GET /api/projects': projects,
      [`GET ${P}/audit`]: { entries: [], next: null },
    });
    renderAt('/p/default/production/history?from=2026-11-08&to=2026-11-01');
    expect(await screen.findByText('Pick a day on or after the first')).toBeTruthy();
    expect(api.calls.some((c) => c.path.includes('/audit'))).toBe(false);
  });
});
