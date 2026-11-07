import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ChangeRequest } from '../api';
import { apiError, mockApi, projects, session } from '../../test/server';
import { renderAt } from '../../test/render';

/** Production needs one approval; development takes changes directly. */
const guarded = {
  projects: [
    {
      ...projects.projects[0],
      environments: [
        { key: 'development', name: 'Development', requiredApprovals: 0 },
        { key: 'production', name: 'Production', requiredApprovals: 1 },
      ],
    },
  ],
};

const ID = '11111111-2222-4333-8444-555555555555';
const P = '/api/projects/default';

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

/** What the review page needs once the editor lands on it. */
const opened = (over: Partial<ChangeRequest>): ChangeRequest => ({
  id: ID,
  target: 'flag',
  flag: 'new-checkout',
  segment: null,
  environment: 'production',
  title: '',
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
  ...over,
});

describe('protected environments in the editor', () => {
  it('turns a targeting save into a change request and opens it', async () => {
    let created: ChangeRequest | undefined;
    const api = mockApi({
      'GET /api/session': session,
      'GET /api/projects': guarded,
      [`GET ${P}/flags/new-checkout`]: flag,
      [`GET ${P}/environments/production/ruleset`]: ruleset,
      [`POST ${P}/flags/new-checkout/environments/production/change-requests`]: (b: unknown) => {
        const body = b as { title: string; description?: string };
        created = opened({
          title: body.title,
          description: body.description ?? '',
          diff: [{ path: 'offVariant', op: 'changed', before: 'off', after: 'on' }],
        });
        return [201, created];
      },
      [`GET ${P}/change-requests/${ID}`]: () => created,
    });
    const { user, router } = renderAt('/p/default/production/flags/new-checkout');
    expect(await screen.findByText(/Production is protected/)).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Change requests for this flag' }).getAttribute('href'),
    ).toBe('/p/default/production/change-requests?flag=new-checkout');

    await user.selectOptions(screen.getByLabelText('Serve when off or a prerequisite fails'), 'on');
    await user.click(screen.getByRole('button', { name: 'Review and request approval' }));
    const dialog = screen.getByRole('dialog', {
      name: 'Request approval for New checkout in Production',
    });
    expect(within(dialog).getByLabelText('Title')).toBe(document.activeElement);
    await user.type(within(dialog).getByLabelText('Why (optional)'), 'Incident follow-up');
    await user.click(within(dialog).getByRole('button', { name: 'Open change request' }));

    expect(
      await screen.findByRole('heading', { name: 'Change targeting of New checkout', level: 1 }),
    ).toBeTruthy();
    expect(router.state.location.pathname).toBe(`/p/default/production/change-requests/${ID}`);
    expect(screen.queryByText('Leave without saving?')).toBeNull();
    expect(api.calls.some((c) => c.method === 'PUT')).toBe(false);
    expect(api.calls.find((c) => c.method === 'POST')?.body).toEqual({
      ...{ enabled: true, prerequisites: [], rules: [], fallthrough: { variant: 'off' } },
      offVariant: 'on',
      baseVersion: 5,
      title: 'Change targeting of New checkout',
      description: 'Incident follow-up',
    });
  });

  it('keeps the edits and explains a proposal on top of an old version', async () => {
    mockApi({
      'GET /api/session': session,
      'GET /api/projects': guarded,
      [`GET ${P}/flags/new-checkout`]: flag,
      [`GET ${P}/environments/production/ruleset`]: ruleset,
      [`POST ${P}/flags/new-checkout/environments/production/change-requests`]: apiError(
        409,
        'version_conflict',
        'targeting changed',
        { currentVersion: 6 },
      ),
    });
    const { user } = renderAt('/p/default/production/flags/new-checkout');
    await user.selectOptions(
      await screen.findByLabelText('Serve when off or a prerequisite fails'),
      'on',
    );
    await user.click(screen.getByRole('button', { name: 'Review and request approval' }));
    await user.type(screen.getByLabelText('Title'), 'Flip the off variant');
    await user.click(screen.getByRole('button', { name: 'Open change request' }));
    expect(await screen.findByText(/Someone else saved this flag/)).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('saves directly where the environment is not protected', async () => {
    mockApi({
      'GET /api/session': session,
      'GET /api/projects': guarded,
      [`GET ${P}/flags/new-checkout`]: flag,
      [`GET ${P}/environments/development/ruleset`]: { ...ruleset, environment: 'development' },
    });
    const { user } = renderAt('/p/default/development/flags/new-checkout');
    await user.selectOptions(
      await screen.findByLabelText('Serve when off or a prerequisite fails'),
      'on',
    );
    expect(screen.queryByText(/is protected/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Review and save' })).toBeTruthy();
  });

  it('proposes segment creation, edits and deletion instead of writing them', async () => {
    const beta = {
      key: 'beta',
      name: 'Beta testers',
      description: '',
      included: ['alice'],
      excluded: [],
      rules: [],
      version: 4,
      updatedAt: new Date().toISOString(),
    };
    let created: ChangeRequest | undefined;
    const api = mockApi({
      'GET /api/session': session,
      'GET /api/projects': guarded,
      [`GET ${P}/environments/production/segments`]: { segments: [beta] },
      [`GET ${P}/environments/production/ruleset`]: ruleset,
      [`POST ${P}/environments/production/segments/staff/change-requests`]: (b: unknown) => {
        created = opened({
          target: 'segment',
          flag: null,
          segment: 'staff',
          title: (b as { title: string }).title,
        });
        return [201, created];
      },
      [`POST ${P}/environments/production/segments/beta/change-requests`]: (b: unknown) => {
        created = opened({
          target: 'segment',
          flag: null,
          segment: 'beta',
          title: (b as { title: string }).title,
        });
        return [201, created];
      },
      [`GET ${P}/change-requests/${ID}`]: () => created,
    });
    const { user, router } = renderAt('/p/default/production/segments');

    await user.click(await screen.findByRole('button', { name: 'Create segment' }));
    let dialog = screen.getByRole('dialog', { name: 'Create segment' });
    expect(
      within(dialog).getByText(/saving opens a change request that needs 1 approval/),
    ).toBeTruthy();
    await user.type(within(dialog).getByLabelText('Name'), 'Staff');
    await user.type(within(dialog).getByLabelText('Always include'), 'carol');
    await user.click(within(dialog).getByRole('button', { name: 'Request approval' }));
    expect(
      await screen.findByRole('heading', { name: 'Create segment Staff', level: 1 }),
    ).toBeTruthy();
    expect(router.state.location.pathname).toBe(`/p/default/production/change-requests/${ID}`);
    expect(api.calls.find((c) => c.method === 'POST')?.body).toEqual({
      baseVersion: 0,
      title: 'Create segment Staff',
      segment: { name: 'Staff', description: '', included: ['carol'], excluded: [], rules: [] },
    });

    await router.navigate('/p/default/production/segments');
    await user.click(await screen.findByRole('button', { name: /Beta testers/ }));
    dialog = screen.getByRole('dialog', { name: 'Beta testers' });
    await user.type(within(dialog).getByLabelText('Always include'), '\nbob');
    await user.click(within(dialog).getByRole('button', { name: 'Request approval' }));
    expect(
      await screen.findByRole('heading', { name: 'Edit segment Beta testers', level: 1 }),
    ).toBeTruthy();
    expect(api.calls.filter((c) => c.method === 'POST').at(-1)?.body).toEqual({
      baseVersion: 4,
      title: 'Edit segment Beta testers',
      segment: {
        name: 'Beta testers',
        description: '',
        included: ['alice', 'bob'],
        excluded: [],
        rules: [],
      },
    });

    await router.navigate('/p/default/production/segments');
    await user.click(await screen.findByRole('button', { name: /Beta testers/ }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Request deletion' }));
    expect(
      await screen.findByRole('heading', { name: 'Delete segment Beta testers', level: 1 }),
    ).toBeTruthy();
    expect(api.calls.filter((c) => c.method === 'POST').at(-1)?.body).toEqual({
      baseVersion: 4,
      title: 'Delete segment Beta testers',
      segment: null,
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(api.calls.some((c) => c.method === 'PUT' || c.method === 'DELETE')).toBe(false);
  });
});
