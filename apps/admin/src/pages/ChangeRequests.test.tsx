import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ChangeRequestSummary } from '../api';
import { mockApi, projects, session } from '../../test/server';
import { renderAt } from '../../test/render';

const LIST = 'GET /api/projects/default/change-requests';

const guarded = {
  projects: [
    {
      ...projects.projects[0],
      environments: [
        { key: 'development', name: 'Development', requiredApprovals: 0 },
        { key: 'production', name: 'Production', requiredApprovals: 2 },
      ],
    },
  ],
};

function summary(i: number, over: Partial<ChangeRequestSummary> = {}): ChangeRequestSummary {
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    target: 'flag',
    flag: 'checkout',
    segment: null,
    environment: 'production',
    title: `Request ${i}`,
    status: 'open',
    revision: 1,
    author: 'Alice',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    approvals: { required: 2, approvedBy: ['Bob'], changesRequestedBy: [] },
    stale: false,
    ...over,
  };
}

describe('change request list', () => {
  it('lists open requests in the environment and pages back through older ones', async () => {
    const api = mockApi({
      'GET /api/session': session,
      'GET /api/projects': guarded,
      [LIST]: (_: unknown, url: URL) => {
        const before = url.searchParams.get('before');
        if (before === null) {
          return {
            changeRequests: [
              summary(1),
              summary(2, { stale: true }),
              summary(3, {
                target: 'segment',
                flag: null,
                segment: 'beta',
                approvals: { required: 2, approvedBy: [], changesRequestedBy: ['Carol'] },
              }),
            ],
            next: summary(3).id,
          };
        }
        return { changeRequests: [summary(4)], next: null };
      },
    });
    const { user } = renderAt('/p/default/production/change-requests');
    const list = await screen.findByRole('list', { name: 'Change requests' });
    expect(screen.getByText(/need 2 approvals before they go live/)).toBeTruthy();
    expect(api.calls.find((c) => c.path.startsWith('/api/projects/default/change'))?.path).toBe(
      '/api/projects/default/change-requests?status=open&environment=production&limit=25',
    );
    const links = within(list).getAllByRole('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      `/p/default/production/change-requests/${summary(1).id}`,
      `/p/default/production/change-requests/${summary(2).id}`,
      `/p/default/production/change-requests/${summary(3).id}`,
    ]);
    expect(within(links[0] as HTMLElement).getByText('1/2')).toBeTruthy();
    expect(within(links[1] as HTMLElement).getByText('Out of date')).toBeTruthy();
    expect(within(links[2] as HTMLElement).getByText(/Segment/)).toBeTruthy();
    expect(within(links[2] as HTMLElement).getByText('0/2 · changes requested')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Show older requests' }));
    expect(await within(list).findByText('Request 4')).toBeTruthy();
    expect(api.calls.at(-1)?.path).toContain(`before=${summary(3).id}`);
    expect(screen.queryByRole('button', { name: 'Show older requests' })).toBeNull();
  });

  it('switches status, filters by flag and says when there is nothing', async () => {
    const api = mockApi({
      'GET /api/session': session,
      'GET /api/projects': projects,
      [LIST]: (_: unknown, url: URL) =>
        url.searchParams.get('status') === 'applied'
          ? { changeRequests: [summary(9, { status: 'applied', stale: null })], next: null }
          : { changeRequests: [], next: null },
    });
    const { user } = renderAt('/p/default/production/change-requests?flag=checkout');
    expect(await screen.findByText('No open change requests')).toBeTruthy();
    expect(screen.getByText(/change requests are optional here/)).toBeTruthy();
    expect(screen.getByText('checkout', { selector: '.mono' })).toBeTruthy();
    expect(api.calls.at(-1)?.path).toContain('flag=checkout');

    await user.click(screen.getByRole('radio', { name: 'Applied' }));
    const list = await screen.findByRole('list', { name: 'Change requests' });
    expect(within(list).getByText('Applied')).toBeTruthy();
    expect(api.calls.at(-1)?.path).toContain('status=applied');

    await user.click(screen.getByRole('link', { name: 'Show all' }));
    expect(await screen.findByText('Request 9')).toBeTruthy();
    expect(api.calls.at(-1)?.path).not.toContain('flag=');
  });
});
