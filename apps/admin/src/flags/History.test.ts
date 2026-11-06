import { describe, expect, it } from 'vitest';
import type { AuditEntry } from '../api';
import { describeAction } from './History';

const entry = (action: string): AuditEntry => ({
  id: 1,
  at: '2026-11-06T09:00:00Z',
  actor: 'alice',
  action,
  targetType: 'flag',
  targetKey: 'checkout',
  environment: 'production',
  diff: [],
});

describe('describeAction', () => {
  it('names every change request step and the approvals setting', () => {
    expect(
      [
        'flag.change_request.open',
        'flag.change_request.approve',
        'flag.change_request.request_changes',
        'flag.change_request.apply',
        'flag.change_request.rebase',
        'flag.change_request.close',
        'environment.approvals',
      ].map((a) => describeAction(entry(a))),
    ).toEqual([
      'opened a change request for',
      'approved a change request for',
      'requested changes to a change request for',
      'applied a change request to',
      'rebased a change request for',
      'closed a change request for',
      'changed the approvals needed in',
    ]);
  });

  it('falls back to the raw action name', () => {
    expect(describeAction(entry('flag.something_new'))).toBe('flag.something_new');
  });
});
