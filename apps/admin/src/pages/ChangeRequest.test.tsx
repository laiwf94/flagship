import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ChangeRequest, EnvConfig } from '../api';
import { apiError, mockApi, projects, session } from '../../test/server';
import { renderAt } from '../../test/render';

const ID = '7d9c2f0e-1b2a-4c3d-8e4f-5a6b7c8d9e0f';
const URL = `/p/default/production/change-requests/${ID}`;
const CR = `/api/projects/default/change-requests/${ID}`;
const RULESET = 'GET /api/projects/default/environments/production/ruleset';

const flagConfig = (over: Partial<EnvConfig> = {}): EnvConfig => ({
  enabled: true,
  offVariant: 'off',
  prerequisites: [],
  rules: [],
  fallthrough: { variant: 'off' },
  ...over,
});

const half = {
  rollout: {
    variants: [
      { variant: 'on', weight: 50_000 },
      { variant: 'off', weight: 50_000 },
    ],
  },
};

function makeRequest(over: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    id: ID,
    target: 'flag',
    flag: 'checkout',
    segment: null,
    environment: 'production',
    title: 'Half of everyone',
    description: 'Ramp up after the beta looked good.',
    status: 'open',
    revision: 1,
    author: 'Alice',
    authorId: 'u2',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    finishedAt: null,
    finishedBy: null,
    baseVersion: 4,
    base: flagConfig(),
    proposed: flagConfig({ fallthrough: half }),
    diff: [{ path: 'fallthrough', op: 'changed', before: { variant: 'off' }, after: half }],
    approvals: { required: 1, approvedBy: [], changesRequestedBy: [] },
    live: { version: 4, stale: false, changedSinceBase: [], conflicts: [] },
    canApply: false,
    reviews: [],
    ...over,
  };
}

const boolFlag = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  type: 'boolean',
  variants: [
    { key: 'on', value: true },
    { key: 'off', value: false },
  ],
  salt: key,
  clientSide: false,
  version: 4,
  enabled: true,
  offVariant: 'off',
  prerequisites: [],
  rules: [],
  fallthrough: { variant: 'off' },
  ...over,
});

const ruleset = {
  environment: 'production',
  version: 12,
  flags: {
    checkout: boolFlag('checkout'),
    beta: boolFlag('beta', {
      rules: [
        {
          id: 'b',
          clauses: [{ operator: 'inSegment', segments: ['testers'] }],
          serve: { variant: 'on' },
        },
      ],
    }),
    payments: boolFlag('payments', {
      prerequisites: [{ flag: 'beta', variant: 'on' }],
      fallthrough: { variant: 'on' },
    }),
  },
  segments: {
    testers: { key: 'testers', included: ['user-1'], excluded: [], rules: [], version: 3 },
  },
};

function setup(request: ChangeRequest, routes: Record<string, unknown> = {}, role = 'editor') {
  let current = request;
  const api = mockApi({
    'GET /api/session': { ...session, user: { ...session.user, role } },
    'GET /api/projects': projects,
    [`GET ${CR}`]: () => current,
    [RULESET]: ruleset,
    ...routes,
  });
  return {
    api,
    set: (next: ChangeRequest) => {
      current = next;
    },
  };
}

describe('change request review', () => {
  it('shows what changes and who it moves, then approves and applies', async () => {
    const { api, set } = setup(makeRequest(), {
      [`POST ${CR}/reviews`]: (body: unknown) => {
        const b = body as { decision: string; body?: string };
        const next = makeRequest({
          approvals: { required: 1, approvedBy: ['Eddie'], changesRequestedBy: [] },
          canApply: true,
          reviews: [
            {
              id: 1,
              revision: 1,
              reviewer: 'Eddie',
              decision: 'approve',
              body: b.body ?? '',
              at: new Date().toISOString(),
            },
          ],
        });
        set(next);
        return [201, next];
      },
      [`POST ${CR}/apply`]: () => {
        const next = makeRequest({
          status: 'applied',
          live: null,
          finishedBy: 'Eddie',
          finishedAt: new Date().toISOString(),
          approvals: { required: 1, approvedBy: ['Eddie'], changesRequestedBy: [] },
        });
        set(next);
        return next;
      },
    });
    const { user } = renderAt(URL);
    expect(await screen.findByRole('heading', { name: 'Half of everyone', level: 1 })).toBeTruthy();
    expect(screen.getByText('Open')).toBeTruthy();
    expect(screen.getByText('Ramp up after the beta looked good.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'checkout' }).getAttribute('href')).toBe(
      '/p/default/production/flags/checkout',
    );
    const changes = screen.getByRole('list', { name: 'Changes' });
    expect(within(changes).getByText('Default rule')).toBeTruthy();

    // Half of the 10,000 sample users move from off to on.
    const moved = await screen.findByText(
      /sample users .* would change variant if this is applied/,
    );
    const n = Number(/^([\d,]+) of/.exec(moved.textContent)?.[1]?.replace(/,/g, ''));
    expect(n).toBeGreaterThan(4500);
    expect(n).toBeLessThan(5500);

    expect(screen.getByText('Needs 1 approval, has 0.')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Apply change' }).disabled).toBe(
      true,
    );
    expect(screen.queryByRole('button', { name: /Close without applying/ })).toBeNull();

    await user.type(screen.getByLabelText('Your review'), 'Looks right');
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Approved.')).toBeTruthy();
    expect(api.calls.find((c) => c.path === `${CR}/reviews`)?.body).toEqual({
      revision: 1,
      decision: 'approve',
      body: 'Looks right',
    });
    const reviews = screen.getByRole('list', { name: 'Reviews' });
    expect(within(reviews).getByText('approved')).toBeTruthy();
    expect(within(reviews).getByText('Looks right')).toBeTruthy();
    expect(screen.getByLabelText<HTMLTextAreaElement>('Your review').value).toBe('');

    await user.click(screen.getByRole('button', { name: 'Apply change' }));
    expect(await screen.findByText('Applied to Production.')).toBeTruthy();
    expect(api.calls.find((c) => c.path === `${CR}/apply`)?.body).toEqual({ revision: 1 });
    expect(screen.getByText('Applied')).toBeTruthy();
    expect(screen.getByText(/by Eddie/)).toBeTruthy();
    expect(screen.queryByLabelText('Your review')).toBeNull();
    expect(screen.getByText(/would change variant with this change/)).toBeTruthy();
  });

  it('never offers the author an approval, and lets them close it with a reason', async () => {
    const { api, set } = setup(makeRequest({ authorId: 'u1', author: 'Eddie' }), {
      [`POST ${CR}/close`]: (body: unknown) => {
        const next = makeRequest({
          authorId: 'u1',
          author: 'Eddie',
          status: 'closed',
          live: null,
          finishedBy: 'Eddie',
          finishedAt: new Date().toISOString(),
          reviews: [
            {
              id: 3,
              revision: 1,
              reviewer: 'Eddie',
              decision: 'comment',
              body: (body as { reason: string }).reason,
              at: new Date().toISOString(),
            },
          ],
        });
        set(next);
        return next;
      },
    });
    const { user } = renderAt(URL);
    await screen.findByRole('heading', { name: 'Half of everyone', level: 1 });
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Request changes' })).toBeNull();
    expect(screen.getByText(/someone else has to approve it/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Close without applying' }));
    const dialog = screen.getByRole('dialog', { name: 'Close this change request?' });
    await user.type(within(dialog).getByLabelText('Reason (optional)'), 'Doing it differently');
    await user.click(within(dialog).getByRole('button', { name: 'Close request' }));
    expect(await screen.findByText('Closed the change request.')).toBeTruthy();
    expect(api.calls.find((c) => c.path === `${CR}/close`)?.body).toEqual({
      reason: 'Doing it differently',
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(screen.getByText('Closed')).toBeTruthy();
    expect(screen.getByText('Doing it differently')).toBeTruthy();
  });

  it('needs text for a comment, records requested changes and explains why apply waits', async () => {
    const { api, set } = setup(makeRequest(), {
      [`POST ${CR}/reviews`]: (body: unknown) => {
        const b = body as { decision: 'comment' | 'request_changes'; body?: string };
        const next = makeRequest({
          approvals: {
            required: 1,
            approvedBy: [],
            changesRequestedBy: b.decision === 'request_changes' ? ['Eddie'] : [],
          },
          reviews: [
            {
              id: 2,
              revision: 1,
              reviewer: 'Eddie',
              decision: b.decision,
              body: b.body ?? '',
              at: new Date().toISOString(),
            },
          ],
        });
        set(next);
        return [201, next];
      },
    });
    const { user } = renderAt(URL);
    await screen.findByRole('heading', { name: 'Half of everyone', level: 1 });
    expect(screen.getByText('No reviews yet.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Comment' }));
    expect(screen.getByText('Write something to comment')).toBeTruthy();
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);

    await user.type(screen.getByLabelText('Your review'), 'Start at 10% instead');
    await user.click(screen.getByRole('button', { name: 'Request changes' }));
    expect(await screen.findByText('Requested changes.')).toBeTruthy();
    expect(api.calls.find((c) => c.method === 'POST')?.body).toEqual({
      revision: 1,
      decision: 'request_changes',
      body: 'Start at 10% instead',
    });
    expect(screen.getByText('Changes requested')).toBeTruthy();
    expect(screen.getByText('Changes were requested by Eddie.')).toBeTruthy();
  });

  it('marks reviews of an earlier revision and lets a stale request be rebased', async () => {
    const stale = makeRequest({
      revision: 2,
      live: {
        version: 6,
        stale: true,
        changedSinceBase: [{ path: 'offVariant', op: 'changed', before: 'off', after: 'on' }],
        conflicts: [],
      },
      reviews: [
        {
          id: 1,
          revision: 1,
          reviewer: 'Bob',
          decision: 'approve',
          body: '',
          at: new Date().toISOString(),
        },
      ],
    });
    const { api, set } = setup(stale, {
      [`POST ${CR}/rebase`]: () => {
        const next = makeRequest({ revision: 3, baseVersion: 6, reviews: stale.reviews });
        set(next);
        return next;
      },
    });
    const { user } = renderAt(URL);
    expect(await screen.findByText('Out of date')).toBeTruthy();
    expect(screen.getByText(/in Production changed since this was proposed/)).toBeTruthy();
    expect(screen.getByText('On revision 1')).toBeTruthy();
    expect(screen.getByText(/revision 2/)).toBeTruthy();
    expect(screen.getByText(/Rebase it first/)).toBeTruthy();
    await user.click(screen.getByText('What changed live'));
    expect(screen.getByText('Variant when off')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Rebase' }));
    expect(await screen.findByText(/Rebased onto the live version/)).toBeTruthy();
    expect(api.calls.find((c) => c.path === `${CR}/rebase`)?.body).toEqual({ revision: 2 });
    expect(screen.queryByText('Out of date')).toBeNull();
    expect(screen.getByText('On revision 1')).toBeTruthy();
  });

  it('lists conflicts instead of offering a rebase', async () => {
    setup(
      makeRequest({
        live: {
          version: 6,
          stale: true,
          changedSinceBase: [],
          conflicts: [
            { path: 'rules[id=beta].serve.variant', base: 'off', ours: 'on', theirs: 'off' },
          ],
        },
      }),
    );
    renderAt(URL);
    const conflicts = await screen.findByRole('list', { name: 'Conflicts' });
    expect(conflicts.textContent).toBe(
      'Rule "beta" › serve › variant: this request sets "on", live is now "off"',
    );
    expect(screen.queryByRole('button', { name: 'Rebase' })).toBeNull();
    expect(screen.getByText(/conflict with this request/)).toBeTruthy();
  });

  it('shows a failed apply and reloads the request as it is now', async () => {
    const { set } = setup(
      makeRequest({
        approvals: { required: 1, approvedBy: ['Bob'], changesRequestedBy: [] },
        canApply: true,
      }),
      {
        [`POST ${CR}/apply`]: () => {
          set(
            makeRequest({
              live: { version: 5, stale: true, changedSinceBase: [], conflicts: [] },
              approvals: { required: 1, approvedBy: ['Bob'], changesRequestedBy: [] },
            }),
          );
          return apiError(409, 'failed_precondition', 'the targeting changed since the base');
        },
      },
    );
    const { user } = renderAt(URL);
    await user.click(await screen.findByRole('button', { name: 'Apply change' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'The targeting changed since the base',
    );
    expect(await screen.findByText('Out of date')).toBeTruthy();
  });

  it('lets viewers read but not review', async () => {
    setup(makeRequest(), {}, 'viewer');
    renderAt(URL);
    await screen.findByRole('heading', { name: 'Half of everyone', level: 1 });
    expect(screen.queryByLabelText('Your review')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Apply change' })).toBeNull();
  });

  it('previews a segment edit on every flag that depends on it', async () => {
    setup(
      makeRequest({
        target: 'segment',
        flag: null,
        segment: 'testers',
        title: 'Add the support team',
        base: { name: 'Testers', description: '', included: ['user-1'], excluded: [], rules: [] },
        proposed: {
          name: 'Testers',
          description: '',
          included: ['user-1', 'user-2', 'user-3'],
          excluded: [],
          rules: [],
        },
        diff: [
          {
            path: 'included',
            op: 'changed',
            before: ['user-1'],
            after: ['user-1', 'user-2', 'user-3'],
          },
        ],
      }),
    );
    const { user } = renderAt(URL);
    expect(await screen.findByText(/wants to/)).toBeTruthy();
    expect(screen.getByText(/edit segment/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'testers' }).getAttribute('href')).toBe(
      '/p/default/production/segments',
    );
    const pick = await screen.findByLabelText<HTMLSelectElement>('Preview for flag');
    expect([...pick.options].map((o) => o.value)).toEqual(['beta', 'payments']);
    expect(screen.getByText('2 flags have variants that depend on this segment.')).toBeTruthy();
    expect(
      screen.getByText('2 of 10,000 sample users (0.0%) would change variant if this is applied.'),
    ).toBeTruthy();
    await user.selectOptions(pick, 'payments');
    expect(
      screen.getByText('2 of 10,000 sample users (0.0%) would change variant if this is applied.'),
    ).toBeTruthy();
  });

  it('says so when no flag uses the segment, and when the flag is not served', async () => {
    const { set } = setup(
      makeRequest({
        target: 'segment',
        flag: null,
        segment: 'brand-new',
        base: null,
        proposed: { name: 'New', description: '', included: ['a'], excluded: [], rules: [] },
      }),
    );
    const { unmount } = renderAt(URL);
    expect(await screen.findByText(/No flag targets this segment/)).toBeTruthy();
    expect(screen.getByText(/create segment/)).toBeTruthy();
    unmount();

    set(makeRequest({ flag: 'archived-one' }));
    renderAt(URL);
    expect(await screen.findByText(/isn.t served in this environment/)).toBeTruthy();
  });

  it('explains a missing request', async () => {
    mockApi({
      'GET /api/session': session,
      'GET /api/projects': projects,
      [`GET ${CR}`]: apiError(404, 'not_found', 'change request not found'),
    });
    renderAt(URL);
    expect(
      await screen.findByText(`There is no change request "${ID}" in Default project.`),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Change requests' })).toBeTruthy();
  });
});
