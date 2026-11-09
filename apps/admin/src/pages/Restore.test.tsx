import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { apiError, mockApi, projects, session } from '../../test/server';
import { renderAt } from '../../test/render';
import { restoreTarget } from '../flags/RestoreDialog';

const P = '/api/projects/default';
const HISTORY = '/p/default/production/history';
const ID = '11111111-2222-4333-8444-555555555555';

const entry = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  at: '2026-11-06T09:00:00Z',
  actor: 'Ana Lima',
  action: 'flag.config.update',
  targetType: 'flag',
  targetKey: 'new-checkout',
  environment: 'production',
  reason: null,
  link: null,
  diff: [{ op: 'changed', path: 'fallthrough.variant', before: 'off', after: 'on' }],
  restorable: true,
  ...over,
});

const plan = (to: 'before' | 'after', over: Record<string, unknown> = {}) => ({
  entry: 7,
  kind: 'targeting',
  target: 'new-checkout',
  environment: 'production',
  to,
  baseVersion: 9,
  current: {},
  restored: {},
  diff: [
    {
      op: 'changed',
      path: 'fallthrough.variant',
      before: to === 'before' ? 'on' : 'off',
      after: to === 'before' ? 'off' : 'on',
    },
  ],
  requiredApprovals: 0,
  unchanged: false,
  ...over,
});

function withEnv(production: Record<string, unknown>) {
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

function restoreApi(routes: Record<string, unknown>, projectList: unknown = projects) {
  return mockApi({
    'GET /api/session': session,
    'GET /api/projects': projectList,
    [`GET ${P}/audit`]: { entries: [entry(7), entry(6, { restorable: false })], next: null },
    [`GET ${P}/audit/7/restore`]: (_b: unknown, url: URL) =>
      plan(url.searchParams.get('to') as 'before' | 'after'),
    ...routes,
  });
}

describe('restoring from History', () => {
  it('reviews the diff for either side, restores, and reloads History', async () => {
    let restored = false;
    const api = restoreApi({
      [`POST ${P}/audit/7/restore`]: () => {
        restored = true;
        return { outcome: 'applied', plan: plan('before', { unchanged: true }) };
      },
    });
    api.set(`GET ${P}/audit`, () =>
      restored
        ? {
            entries: [entry(8, { action: 'flag.config.restore', reason: 'Bad rollout' }), entry(7)],
            next: null,
          }
        : { entries: [entry(7), entry(6, { restorable: false })], next: null },
    );
    const { user } = renderAt(HISTORY);
    const buttons = await screen.findAllByRole('button', { name: /^Restore #/ });
    // Only entries the server marks restorable offer it.
    expect(buttons).toHaveLength(1);
    await user.click(buttons[0] as HTMLElement);

    const dialog = await screen.findByRole('dialog', { name: 'Restore #7' });
    expect(
      await within(dialog).findByText(
        'What changes in the targeting of new-checkout in Production',
      ),
    ).toBeTruthy();
    expect(within(dialog).getByLabelText<HTMLInputElement>(/Before this change/).checked).toBe(
      true,
    );
    await user.click(within(dialog).getByLabelText(/Right after this change/));
    await waitFor(() => {
      expect(api.calls.some((c) => c.path.endsWith('/audit/7/restore?to=after'))).toBe(true);
    });
    await user.click(within(dialog).getByLabelText(/Before this change/));
    await user.type(await within(dialog).findByLabelText('Reason (optional)'), 'Bad rollout');
    await user.click(within(dialog).getByRole('button', { name: 'Restore' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    const post = api.calls.find((c) => c.method === 'POST');
    expect(post?.body).toEqual({ to: 'before', baseVersion: 9 });
    expect(post?.headers['flagship-reason']).toBe('Bad%20rollout');
    expect(await screen.findByText('Bad rollout')).toBeTruthy();
    expect(await screen.findByText(/restored earlier targeting of/)).toBeTruthy();
  });

  it('opens a change request in a protected environment and goes to it', async () => {
    const api = restoreApi(
      {
        [`GET ${P}/audit/7/restore`]: plan('before', { requiredApprovals: 2 }),
        [`POST ${P}/audit/7/restore`]: [
          201,
          { outcome: 'proposed', changeRequest: { id: ID, status: 'open' } },
        ],
        [`GET ${P}/change-requests/${ID}`]: [404, { error: { code: 'not_found', message: 'x' } }],
      },
      withEnv({ requiredApprovals: 2, requireLink: true }),
    );
    const { user, router } = renderAt(HISTORY);
    await user.click(await screen.findByRole('button', { name: /^Restore #7/ }));
    const dialog = await screen.findByRole('dialog');
    expect(
      await within(dialog).findByText(/Production is protected: restoring opens a change request/),
    ).toBeTruthy();
    // The title is the reason, so only the link is asked for, and it is required here.
    expect(within(dialog).queryByLabelText(/^Reason/)).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Open change request' }));
    expect(
      await within(dialog).findByText('Production needs a ticket link for every change'),
    ).toBeTruthy();
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);

    await user.type(within(dialog).getByLabelText('Title (optional)'), 'Undo the 50% rollout');
    await user.type(within(dialog).getByLabelText('Ticket link'), 'https://t.example/INC-5');
    await user.click(within(dialog).getByRole('button', { name: 'Open change request' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/p/default/production/change-requests/${ID}`);
    });
    const post = api.calls.find((c) => c.method === 'POST');
    expect(post?.body).toEqual({ to: 'before', baseVersion: 9, title: 'Undo the 50% rollout' });
    expect(post?.headers['flagship-link']).toBe('https://t.example/INC-5');
  });

  it('says when there is nothing to restore and disables the button', async () => {
    restoreApi({ [`GET ${P}/audit/7/restore`]: plan('before', { unchanged: true, diff: [] }) });
    const { user } = renderAt(HISTORY);
    await user.click(await screen.findByRole('button', { name: /^Restore #7/ }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/already matches this/)).toBeTruthy();
    expect(
      within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Restore' }).disabled,
    ).toBe(true);
  });

  it('reloads the plan after a conflict and shows refusals from the server', async () => {
    let version = 9;
    const api = restoreApi({
      [`GET ${P}/audit/7/restore`]: () => plan('before', { baseVersion: version }),
      [`POST ${P}/audit/7/restore`]: (b: unknown) => {
        if ((b as { baseVersion: number }).baseVersion === 9) {
          version = 10;
          return apiError(409, 'version_conflict', 'changed', { currentVersion: 10 });
        }
        return apiError(400, 'invalid_argument', 'segment "beta" does not exist');
      },
    });
    const { user } = renderAt(HISTORY);
    await user.click(await screen.findByRole('button', { name: /^Restore #7/ }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText(/What changes in/);
    await user.click(within(dialog).getByRole('button', { name: 'Restore' }));
    expect(await within(dialog).findByText(/This changed while you were reviewing/)).toBeTruthy();
    await waitFor(() => {
      expect(api.calls.filter((c) => c.path.endsWith('/restore?to=before'))).toHaveLength(2);
    });
    await user.click(within(dialog).getByRole('button', { name: 'Restore' }));
    expect(await within(dialog).findByText('segment "beta" does not exist')).toBeTruthy();
    const posts = api.calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => (c.body as { baseVersion: number }).baseVersion)).toEqual([9, 10]);
  });

  it('shows a reason refused by the server on the field', async () => {
    restoreApi({
      [`POST ${P}/audit/7/restore`]: apiError(400, 'invalid_argument', 'needs a reason', [
        { path: 'header.flagship-reason', message: 'is required in production' },
      ]),
    });
    const { user } = renderAt(HISTORY);
    await user.click(await screen.findByRole('button', { name: /^Restore #7/ }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText(/What changes in/);
    await user.click(within(dialog).getByRole('button', { name: 'Restore' }));
    expect(await within(dialog).findByText('Reason is required in production')).toBeTruthy();
  });

  it('shows why a plan could not be made', async () => {
    restoreApi({
      [`GET ${P}/audit/7/restore`]: apiError(400, 'invalid_argument', 'nothing to restore here'),
    });
    const { user } = renderAt(HISTORY);
    await user.click(await screen.findByRole('button', { name: /^Restore #7/ }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('nothing to restore here')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('offers no Restore to viewers', async () => {
    mockApi({
      'GET /api/session': { ...session, user: { ...session.user, role: 'viewer' } },
      'GET /api/projects': projects,
      [`GET ${P}/audit`]: { entries: [entry(7)], next: null },
    });
    renderAt(HISTORY);
    expect(await screen.findByText(/changed targeting of/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Restore #/ })).toBeNull();
  });

  it('names what is restored', () => {
    expect(restoreTarget({ kind: 'flag', target: 'f' }, '')).toBe('the settings of f');
    expect(restoreTarget({ kind: 'segment', target: 's' }, 'Production')).toBe(
      'segment s in Production',
    );
  });
});
