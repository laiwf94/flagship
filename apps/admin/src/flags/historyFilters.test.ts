import { describe, expect, it } from 'vitest';
import {
  draftFromParams,
  hasFilters,
  NO_FILTERS,
  paramsFromDraft,
  toAuditFilters,
} from './historyFilters';

describe('history filters', () => {
  it('round-trips through the address, keeping only what is set', () => {
    const draft = { q: ' "kill switch" ', actor: 'Ana Lima', from: '2026-11-01', to: '' };
    const params = paramsFromDraft(draft);
    expect(params.toString()).toBe('q=%22kill+switch%22&actor=Ana+Lima&from=2026-11-01');
    expect(draftFromParams(params)).toEqual({ ...draft, q: '"kill switch"' });
    expect(draftFromParams(new URLSearchParams())).toEqual(NO_FILTERS);
    expect(paramsFromDraft(NO_FILTERS).toString()).toBe('');
  });

  it('turns local days into an inclusive start and an exclusive end', () => {
    const r = toAuditFilters({ q: 'INC-42', actor: '', from: '2026-11-01', to: '2026-11-07' });
    expect(r).toEqual({
      ok: true,
      filters: {
        q: 'INC-42',
        from: new Date(2026, 10, 1).toISOString(),
        to: new Date(2026, 10, 8).toISOString(),
      },
    });
    // One day is a 24-hour window starting at local midnight.
    const day = toAuditFilters({ ...NO_FILTERS, from: '2026-12-31', to: '2026-12-31' });
    expect(day).toEqual({
      ok: true,
      filters: {
        from: new Date(2026, 11, 31).toISOString(),
        to: new Date(2027, 0, 1).toISOString(),
      },
    });
  });

  it('refuses malformed days, a backwards range and overlong text', () => {
    expect(toAuditFilters({ ...NO_FILTERS, from: '2026-02-30' })).toEqual({
      ok: false,
      errors: { from: 'Pick a day' },
    });
    expect(toAuditFilters({ ...NO_FILTERS, to: 'yesterday' })).toEqual({
      ok: false,
      errors: { to: 'Pick a day' },
    });
    expect(toAuditFilters({ ...NO_FILTERS, from: '2026-11-08', to: '2026-11-07' })).toEqual({
      ok: false,
      errors: { to: 'Pick a day on or after the first' },
    });
    expect(toAuditFilters({ ...NO_FILTERS, q: 'x'.repeat(201), actor: 'y'.repeat(101) })).toEqual({
      ok: false,
      errors: {
        q: 'Keep the search under 200 characters',
        actor: 'Keep the name under 100 characters',
      },
    });
  });

  it('knows when nothing narrows the list', () => {
    expect(hasFilters({})).toBe(false);
    expect(hasFilters({ actor: 'Ana' })).toBe(true);
  });
});
