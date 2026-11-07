import type { Ruleset } from '@flagship/core';
import type { ChangeRequest, EnvConfig, SegmentContent } from '../api';

/**
 * The environment's ruleset with a change request's target set to one side
 * of the request. Every other flag and segment stays as it is live, so the
 * preview shows what the request does in the context it would land in.
 * Returns undefined when the target isn't in the ruleset (an archived flag).
 */
export function rulesetWith(
  ruleset: Ruleset,
  request: Pick<ChangeRequest, 'target' | 'flag' | 'segment'>,
  side: EnvConfig | SegmentContent | null,
): Ruleset | undefined {
  if (request.target === 'flag') {
    const key = request.flag ?? '';
    const live = ruleset.flags[key];
    if (live === undefined || side === null) return undefined;
    const c = side as EnvConfig;
    return {
      ...ruleset,
      flags: {
        ...ruleset.flags,
        [key]: {
          ...live,
          enabled: c.enabled,
          offVariant: c.offVariant,
          prerequisites: c.prerequisites,
          rules: c.rules,
          fallthrough: c.fallthrough,
        },
      },
    };
  }
  const key = request.segment ?? '';
  const segments = Object.fromEntries(Object.entries(ruleset.segments).filter(([k]) => k !== key));
  if (side !== null) {
    const s = side as SegmentContent;
    segments[key] = {
      key,
      included: s.included,
      excluded: s.excluded,
      rules: s.rules,
      version: ruleset.segments[key]?.version ?? 0,
    };
  }
  return { ...ruleset, segments };
}

/**
 * Flags whose variants can depend on a segment: those with a rule that
 * targets it, and every flag that has one of those as a prerequisite, however
 * deep. Sorted by key.
 */
export function flagsUsingSegment(ruleset: Ruleset, segment: string): string[] {
  const flags = Object.values(ruleset.flags);
  const found = new Set(
    flags
      .filter((f) =>
        f.rules.some((r) =>
          r.clauses.some((c) => c.operator === 'inSegment' && c.segments.includes(segment)),
        ),
      )
      .map((f) => f.key),
  );
  for (let grew = true; grew;) {
    grew = false;
    for (const f of flags) {
      if (!found.has(f.key) && f.prerequisites.some((p) => found.has(p.flag))) {
        found.add(f.key);
        grew = true;
      }
    }
  }
  return [...found].sort();
}

/** Why apply isn't possible yet, or undefined when it is. */
export function applyBlocker(request: ChangeRequest): string | undefined {
  if (request.status !== 'open') return `This change request is ${request.status}.`;
  if (request.live?.stale === true) {
    return request.live.conflicts.length > 0
      ? 'The live version changed in ways that conflict with this request.'
      : 'The live version changed since this was proposed. Rebase it first.';
  }
  const { required, approvedBy, changesRequestedBy } = request.approvals;
  if (changesRequestedBy.length > 0)
    return `Changes were requested by ${changesRequestedBy.join(', ')}.`;
  if (approvedBy.length < required) {
    return `Needs ${required} ${required === 1 ? 'approval' : 'approvals'}, has ${approvedBy.length}.`;
  }
  return undefined;
}
