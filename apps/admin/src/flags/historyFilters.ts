/** History filters as they sit in the page address, so a search can be shared and reloaded. */
export interface FilterDraft {
  q: string;
  actor: string;
  /** Inclusive local day, YYYY-MM-DD. */
  from: string;
  /** Inclusive local day, YYYY-MM-DD. */
  to: string;
}

/** What the audit endpoint takes: from inclusive and to exclusive, as instants. */
export interface AuditFilters {
  q?: string;
  actor?: string;
  from?: string;
  to?: string;
}

export const NO_FILTERS: FilterDraft = { q: '', actor: '', from: '', to: '' };

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Local midnight at the start of a YYYY-MM-DD day, or undefined for a malformed one. */
function startOfDay(day: string, plusDays = 0): Date | undefined {
  const m = DAY.exec(day);
  if (m === null) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = new Date(y, mo - 1, d + plusDays);
  // Reject days like 2026-02-30 that Date would roll over.
  const check = new Date(y, mo - 1, d);
  if (check.getFullYear() !== y || check.getMonth() !== mo - 1 || check.getDate() !== d) {
    return undefined;
  }
  return at;
}

export function draftFromParams(params: URLSearchParams): FilterDraft {
  return {
    q: params.get('q') ?? '',
    actor: params.get('actor') ?? '',
    from: params.get('from') ?? '',
    to: params.get('to') ?? '',
  };
}

/** The address for a draft: only filters that are set, in a stable order. */
export function paramsFromDraft(draft: FilterDraft): URLSearchParams {
  const out = new URLSearchParams();
  for (const k of ['q', 'actor', 'from', 'to'] as const) {
    const v = draft[k].trim();
    if (v !== '') out.set(k, v);
  }
  return out;
}

/**
 * Turns the draft into the endpoint's filters. The "to" day is inclusive in
 * the form, so the query ends at the midnight after it.
 */
export function toAuditFilters(
  draft: FilterDraft,
): { ok: true; filters: AuditFilters } | { ok: false; errors: Partial<FilterDraft> } {
  const errors: Partial<FilterDraft> = {};
  const filters: AuditFilters = {};
  const q = draft.q.trim();
  if (q.length > 200) errors.q = 'Keep the search under 200 characters';
  else if (q !== '') filters.q = q;
  const actor = draft.actor.trim();
  if (actor.length > 100) errors.actor = 'Keep the name under 100 characters';
  else if (actor !== '') filters.actor = actor;
  const from = draft.from === '' ? undefined : startOfDay(draft.from);
  const to = draft.to === '' ? undefined : startOfDay(draft.to, 1);
  if (draft.from !== '' && from === undefined) errors.from = 'Pick a day';
  if (draft.to !== '' && to === undefined) errors.to = 'Pick a day';
  if (from !== undefined && to !== undefined && from.getTime() >= to.getTime())
    errors.to = 'Pick a day on or after the first';
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  if (from !== undefined) filters.from = from.toISOString();
  if (to !== undefined) filters.to = to.toISOString();
  return { ok: true, filters };
}

export function hasFilters(f: AuditFilters): boolean {
  return Object.keys(f).length > 0;
}
