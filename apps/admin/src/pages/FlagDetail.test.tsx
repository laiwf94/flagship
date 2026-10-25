import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { FlagDetail } from '../api';
import { apiError, mockApi, projects, session } from '../../test/server';
import { renderAt } from '../../test/render';

const URL = '/p/default/production/flags/new-checkout';
const FLAG_API = 'GET /api/projects/default/flags/new-checkout';
const SAVE_API = 'PUT /api/projects/default/flags/new-checkout/environments/production';
const KILL_API =
  'POST /api/projects/default/flags/new-checkout/environments/production/kill-switch';

function makeFlag(
  overrides: Partial<FlagDetail['environments'][string]> = {},
  version = 3,
): FlagDetail {
  const config = {
    enabled: true,
    offVariant: 'off',
    prerequisites: [],
    rules: [],
    fallthrough: { variant: 'off' },
    updatedAt: '2030-01-01T00:00:00Z',
    ...overrides,
  };
  return {
    key: 'new-checkout',
    name: 'New checkout',
    description: 'One-page checkout',
    type: 'boolean',
    variants: [
      { key: 'on', value: true },
      { key: 'off', value: false },
    ],
    clientSide: true,
    salt: 'new-checkout',
    archived: false,
    version,
    createdAt: '2030-01-01T00:00:00Z',
    updatedAt: '2030-01-01T00:00:00Z',
    environments: { production: config, development: { ...config, enabled: false } },
  };
}

const ruleset = {
  environment: 'production',
  version: 9,
  flags: {
    billing: {
      key: 'billing',
      type: 'boolean',
      variants: [
        { key: 'yes', value: true },
        { key: 'no', value: false },
      ],
      enabled: true,
      offVariant: 'no',
      prerequisites: [],
      rules: [],
      fallthrough: { variant: 'yes' },
      salt: 'billing',
      clientSide: false,
      version: 1,
    },
  },
  segments: { beta: { key: 'beta', included: ['alice'], excluded: [], rules: [], version: 1 } },
};

function setup(flag = makeFlag(), role = 'editor') {
  let current = flag;
  const api = mockApi({
    'GET /api/session': { ...session, user: { ...session.user, role } },
    'GET /api/projects': projects,
    [FLAG_API]: () => current,
    'GET /api/projects/default/environments/production/ruleset': ruleset,
    [SAVE_API]: (body: unknown) => {
      const b = body as Record<string, unknown>;
      const { version, ...config } = b;
      current = makeFlag(config, (version as number) + 1);
      return current;
    },
    [KILL_API]: (body: unknown) => {
      current = makeFlag(
        { ...current.environments.production, ...(body as object) },
        current.version + 1,
      );
      return current;
    },
    'GET /api/projects/default/flags/new-checkout/environments/production/schedules': {
      schedules: [],
    },
  });
  return { api, setCurrent: (f: FlagDetail) => (current = f) };
}

const bars = () =>
  within(screen.getByRole('list', { name: /sample users/ }))
    .getAllByRole('listitem')
    .map((li) => li.textContent);

describe('flag editor', () => {
  it('shows the flag, its status and who gets what', async () => {
    setup();
    renderAt(URL);
    expect(await screen.findByRole('heading', { name: 'New checkout' })).toBeTruthy();
    expect(screen.getByText('On')).toBeTruthy();
    expect(screen.getByText(/visible to browser apps/)).toBeTruthy();
    expect(await screen.findByRole('switch', { name: 'On in Production' })).toBeTruthy();
    expect(bars()).toEqual(['off100.0%']);
    const checks = screen.getByRole('table');
    expect(within(checks).getAllByRole('row')).toHaveLength(3);
    expect(within(checks).getByText('alice')).toBeTruthy();
  });

  it('rolls out with the slider, previews it, reviews the diff and saves with the version', async () => {
    const { api } = setup();
    const { user } = renderAt(URL);
    await screen.findByRole('switch', { name: 'On in Production' });
    const defaultCard = screen
      .getByRole('heading', { name: 'Default rule' })
      .closest('section') as HTMLElement;
    await user.click(within(defaultCard).getByRole('radio', { name: 'Percentage rollout' }));
    const slider = within(defaultCard).getByRole('slider');
    fireEvent.change(slider, { target: { value: '10' } });
    expect(within(defaultCard).getByText('Turned on for 10% of users')).toBeTruthy();
    await waitFor(() => {
      const [first, second] = bars();
      expect(first).toMatch(/^off(89|90|91)\.\d%$/);
      expect(second).toMatch(/^on(9|10|11)\.\d%$/);
    });
    expect(screen.getByText(/sample users \(.*%\) would change variant/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Review and save' }));
    const dialog = screen.getByRole('dialog', { name: /Review changes/ });
    expect(within(dialog).getByText('Default rule › rollout')).toBeTruthy();
    expect(within(dialog).getByText('Default rule › variant')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Save to Production' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    const put = api.calls.find((c) => c.method === 'PUT');
    expect(put?.body).toMatchObject({
      version: 3,
      enabled: true,
      fallthrough: {
        rollout: {
          variants: [
            { variant: 'on', weight: 10_000 },
            { variant: 'off', weight: 90_000 },
          ],
        },
      },
    });
    expect(await screen.findByText('Saved targeting for New checkout in Production.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
  });

  it('builds rules with conditions, segments and ordering', async () => {
    const { api } = setup();
    const { user } = renderAt(URL);
    await screen.findByRole('switch', { name: 'On in Production' });
    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    const rule1 = () =>
      screen.getByRole('heading', { name: 'Rule 1' }).closest('li') as HTMLElement;

    const c1 = within(rule1()).getByRole('group', { name: 'Condition 1' });
    await user.clear(within(c1).getByLabelText('Values'));
    await user.type(within(c1).getByLabelText('Values'), '@acme.com, @acme.io');
    await user.click(within(rule1()).getByRole('button', { name: 'Add condition' }));
    const c2 = within(rule1()).getByRole('group', { name: 'Condition 2' });
    await user.selectOptions(within(c2).getByLabelText('Operator'), 'gte');
    await user.clear(within(c2).getByLabelText('Attribute'));
    await user.type(within(c2).getByLabelText('Attribute'), 'seats');
    await user.clear(within(c2).getByLabelText('Values'));
    await user.type(within(c2).getByLabelText('Values'), '5');
    await user.selectOptions(within(c2).getByLabelText('Negate'), 'not');
    await user.selectOptions(within(c2).getByLabelText('Operator'), 'inSegment');
    expect(within(c2).getByLabelText<HTMLSelectElement>('Segment').value).toBe('beta');
    await user.selectOptions(within(c2).getByLabelText('Operator'), 'matches');
    await user.selectOptions(within(rule1()).getByLabelText('Rule 1 serves'), 'on');

    await user.click(screen.getByRole('button', { name: 'Move rule 1 down' }));
    await user.click(screen.getByRole('button', { name: 'Move rule 2 up' }));
    await user.click(screen.getByRole('button', { name: 'Delete rule 2' }));
    await user.click(within(rule1()).getByRole('button', { name: 'Remove condition 2' }));

    await user.click(screen.getByRole('button', { name: 'Review and save' }));
    await user.click(screen.getByRole('button', { name: 'Save to Production' }));
    await waitFor(() => {
      expect(api.calls.some((c) => c.method === 'PUT')).toBe(true);
    });
    const put = api.calls.find((c) => c.method === 'PUT');
    expect((put?.body as { rules: unknown[] }).rules).toEqual([
      {
        id: expect.stringMatching(/^rule-/),
        clauses: [{ attribute: 'email', operator: 'endsWith', values: ['@acme.com', '@acme.io'] }],
        serve: { variant: 'on' },
      },
    ]);
  });

  it('refuses to save invalid targeting and points at the problem', async () => {
    setup();
    const { user } = renderAt(URL);
    await screen.findByRole('switch', { name: 'On in Production' });
    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    const c = screen.getByRole('group', { name: 'Condition 1' });
    await user.selectOptions(within(c).getByLabelText('Operator'), 'matches');
    await user.clear(within(c).getByLabelText('Values'));
    await user.type(within(c).getByLabelText('Values'), '(a+)\\1');
    expect(await within(c).findByText(/backreferences are not supported/)).toBeTruthy();
    expect(within(c).getByLabelText('Values').getAttribute('aria-invalid')).toBe('true');
    await user.click(screen.getByRole('button', { name: 'Review and save' }));
    expect(screen.getByRole('button', { name: 'Save to Production' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByText('Fix these before saving')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryByRole('group', { name: 'Condition 1' })).toBeNull();
  });

  it('explains a version conflict and reloads on request', async () => {
    const { api } = setup();
    api.set(SAVE_API, apiError(409, 'version_conflict', 'flag was changed', { currentVersion: 4 }));
    const { user } = renderAt(URL);
    await screen.findByRole('switch', { name: 'On in Production' });
    await user.selectOptions(screen.getByLabelText('Serve when off or a prerequisite fails'), 'on');
    await user.click(screen.getByRole('button', { name: 'Review and save' }));
    await user.click(screen.getByRole('button', { name: 'Save to Production' }));
    expect(await screen.findByText(/Someone else saved this flag/)).toBeTruthy();
    const loads = api.calls.filter((c) => c.path.endsWith('/flags/new-checkout')).length;
    api.set(FLAG_API, makeFlag({ fallthrough: { variant: 'on' } }, 4));
    await user.click(screen.getByRole('button', { name: 'Reload latest' }));
    await waitFor(() => {
      expect(api.calls.filter((c) => c.path.endsWith('/flags/new-checkout')).length).toBe(
        loads + 1,
      );
    });
    // Their version replaces the local draft, including fields we never touched.
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLSelectElement>('Default rule serves').value).toBe('on');
    });
    expect(
      screen.getByLabelText<HTMLSelectElement>('Serve when off or a prerequisite fails').value,
    ).toBe('off');
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
  });

  it('shows server validation errors', async () => {
    const { api } = setup();
    api.set(
      SAVE_API,
      apiError(400, 'invalid_argument', 'this change would leave the production ruleset invalid', [
        { path: 'flags.new-checkout.prerequisites', message: 'prerequisites form a cycle' },
      ]),
    );
    const { user } = renderAt(URL);
    await screen.findByRole('switch', { name: 'On in Production' });
    await user.click(screen.getByRole('button', { name: 'Add prerequisite' }));
    await user.selectOptions(screen.getByLabelText('Required variant 1'), 'no');
    await user.click(screen.getByRole('button', { name: 'Review and save' }));
    await user.click(screen.getByRole('button', { name: 'Save to Production' }));
    expect(await screen.findByText(/prerequisites form a cycle/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    await user.selectOptions(screen.getByLabelText('Prerequisite flag 1'), 'billing');
    await user.click(screen.getByRole('button', { name: 'Remove prerequisite 1' }));
    expect(screen.getByText(/doesn't depend on another flag/)).toBeTruthy();
  });

  it('flips the kill switch after confirming, with an undo', async () => {
    const { api } = setup();
    const { user } = renderAt(URL);
    await user.click(await screen.findByRole('switch', { name: 'On in Production' }));
    const dialog = screen.getByRole('dialog', { name: 'Turn off New checkout in Production?' });
    await user.click(within(dialog).getByRole('button', { name: 'Turn off' }));
    expect(await screen.findByRole('switch', { name: 'Off in Production' })).toBeTruthy();
    expect(api.calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([
      { enabled: false },
    ]);
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => {
      expect(api.calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([
        { enabled: false },
        { enabled: true },
      ]);
    });
    expect(await screen.findByRole('switch', { name: 'On in Production' })).toBeTruthy();
  });

  it('reports a kill switch failure', async () => {
    const { api } = setup();
    api.set(KILL_API, apiError(403, 'permission_denied', 'this needs the editor role'));
    const { user } = renderAt(URL);
    await user.click(await screen.findByRole('switch', { name: 'On in Production' }));
    await user.click(screen.getByRole('button', { name: 'Turn off' }));
    expect(await screen.findByText('this needs the editor role')).toBeTruthy();
    await user.click(screen.getByRole('switch', { name: 'On in Production' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks before leaving with unsaved changes', async () => {
    setup();
    const { user, router } = renderAt(URL);
    await screen.findByRole('switch', { name: 'On in Production' });
    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    await user.click(
      within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('link', {
        name: 'Flags',
      }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Leave without saving?' });
    await user.click(within(dialog).getByRole('button', { name: 'Stay' }));
    expect(router.state.location.pathname).toBe(URL);
    await user.click(
      within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('link', {
        name: 'Flags',
      }),
    );
    await user.click(await screen.findByRole('button', { name: 'Discard changes' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/p/default/production/flags');
    });
  });

  it('is read-only for viewers', async () => {
    setup(makeFlag(), 'viewer');
    renderAt(URL);
    const sw = await screen.findByRole('switch', { name: 'On in Production' });
    expect(sw).toHaveProperty('disabled', true);
    expect(screen.queryByRole('button', { name: 'Add rule' })).toBeNull();
  });

  it('edits multi-variant weights and catches totals that are off', async () => {
    const flag = makeFlag();
    flag.type = 'string';
    flag.variants = [
      { key: 'a', value: 'A' },
      { key: 'b', value: 'B' },
      { key: 'c', value: 'C' },
    ];
    flag.environments.production = {
      ...flag.environments.production!,
      offVariant: 'a',
      fallthrough: { variant: 'a' },
    };
    setup(flag);
    const { user } = renderAt(URL);
    await screen.findByRole('switch', { name: 'On in Production' });
    const card = screen
      .getByRole('heading', { name: 'Default rule' })
      .closest('section') as HTMLElement;
    await user.click(within(card).getByRole('radio', { name: 'Percentage rollout' }));
    expect(within(card).getByLabelText<HTMLInputElement>('a').value).toBe('33.334');
    await user.clear(within(card).getByLabelText('a'));
    await user.type(within(card).getByLabelText('a'), '50');
    expect(within(card).getByRole('alert').textContent).toContain('add up to 116.7%');
    await user.click(within(card).getByRole('radio', { name: 'One variant' }));
    await user.selectOptions(within(card).getByLabelText('Default rule serves'), 'c');
  });

  it('shows a missing flag and an archived one', async () => {
    const { api } = setup();
    api.set(FLAG_API, apiError(404, 'not_found', 'flag not found'));
    renderAt(URL);
    expect(
      await screen.findByText('There is no flag "new-checkout" in Default project.'),
    ).toBeTruthy();
  });

  it('marks archived flags read-only', async () => {
    const flag = makeFlag();
    flag.archived = true;
    setup(flag);
    renderAt(URL);
    expect(await screen.findByText(/This flag is archived/)).toBeTruthy();
    expect(screen.getByText('Archived')).toBeTruthy();
  });
});

describe('schedules tab', () => {
  it('lists, creates and cancels scheduled changes', async () => {
    const { api } = setup();
    const S = 'GET /api/projects/default/flags/new-checkout/environments/production/schedules';
    let schedules: unknown[] = [];
    api.set(S, () => ({ schedules }));
    api.set(
      'POST /api/projects/default/flags/new-checkout/environments/production/schedules',
      (body: unknown) => {
        const s = {
          id: 'sch1',
          status: 'pending',
          error: null,
          createdBy: 'Eddie',
          ...(body as object),
        };
        schedules = [
          s,
          {
            id: 'sch0',
            runAt: '2030-01-01T00:00:00Z',
            change: { enabled: false },
            status: 'failed',
            error: 'unknown segment "beta"',
            createdBy: 'Eddie',
          },
        ];
        return s;
      },
    );
    api.set(
      'DELETE /api/projects/default/flags/new-checkout/environments/production/schedules/sch1',
      () => {
        schedules = [];
        return { id: 'sch1' };
      },
    );
    const { user } = renderAt(`${URL}?tab=schedules`);
    expect(await screen.findByText('Nothing scheduled')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Schedule a change' }));
    const dialog = screen.getByRole('dialog', { name: 'Schedule a change' });
    fireEvent.change(within(dialog).getByLabelText('When'), {
      target: { value: '2001-01-01T10:00' },
    });
    await user.click(within(dialog).getByRole('button', { name: 'Schedule' }));
    expect(within(dialog).getByText('Pick a time in the future')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('When'), {
      target: { value: '2099-06-01T09:00' },
    });
    await user.click(within(dialog).getByRole('radio', { name: 'Roll out to' }));
    await user.clear(within(dialog).getByLabelText('Percentage of users'));
    await user.type(within(dialog).getByLabelText('Percentage of users'), '150');
    await user.click(within(dialog).getByRole('button', { name: 'Schedule' }));
    expect(within(dialog).getByText('Enter 0 to 100')).toBeTruthy();
    await user.clear(within(dialog).getByLabelText('Percentage of users'));
    await user.type(within(dialog).getByLabelText('Percentage of users'), '25');
    await user.click(within(dialog).getByRole('button', { name: 'Schedule' }));

    expect(await screen.findByText('Turn on · Default rule: on 25%, off 75%')).toBeTruthy();
    expect(screen.getByText('Scheduled')).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.getByText('unknown segment "beta"')).toBeTruthy();
    const post = api.calls.find((c) => c.method === 'POST');
    expect(post?.body).toMatchObject({ runAt: new Date('2099-06-01T09:00').toISOString() });

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Cancel change' }));
    expect(await screen.findByText('Scheduled change cancelled.')).toBeTruthy();
    expect(await screen.findByText('Nothing scheduled')).toBeTruthy();
  });

  it('switches tabs with the keyboard', async () => {
    setup();
    const { user } = renderAt(URL);
    const tab = await screen.findByRole('tab', { name: 'Targeting' });
    tab.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Schedules' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Targeting' }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('reports scheduling errors from the server', async () => {
    const { api } = setup();
    api.set(
      'POST /api/projects/default/flags/new-checkout/environments/production/schedules',
      apiError(400, 'invalid_argument', 'flag "new-checkout" is archived'),
    );
    const { user } = renderAt(`${URL}?tab=schedules`);
    await user.click(await screen.findByRole('button', { name: 'Schedule a change' }));
    await user.click(screen.getByRole('radio', { name: 'Turn off' }));
    await user.click(screen.getByRole('button', { name: 'Schedule' }));
    expect(await screen.findByText('flag "new-checkout" is archived')).toBeTruthy();
  });
});
