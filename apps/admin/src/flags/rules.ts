import {
  ROLLOUT_TOTAL,
  type AttributeClause,
  type Rule,
  type Serve,
  type Variant,
} from '@flagship/core';

export type OperatorKey = AttributeClause['operator'] | 'inSegment';

export const OPERATORS: {
  value: OperatorKey;
  label: string;
  kind: 'list' | 'one' | 'number' | 'version' | 'pattern' | 'segment';
}[] = [
  { value: 'in', label: 'is one of', kind: 'list' },
  { value: 'equals', label: 'is', kind: 'one' },
  { value: 'contains', label: 'contains', kind: 'list' },
  { value: 'startsWith', label: 'starts with', kind: 'list' },
  { value: 'endsWith', label: 'ends with', kind: 'list' },
  { value: 'matches', label: 'matches pattern', kind: 'pattern' },
  { value: 'lt', label: 'is less than', kind: 'number' },
  { value: 'lte', label: 'is at most', kind: 'number' },
  { value: 'gt', label: 'is greater than', kind: 'number' },
  { value: 'gte', label: 'is at least', kind: 'number' },
  { value: 'semverEq', label: 'version is', kind: 'version' },
  { value: 'semverLt', label: 'version is below', kind: 'version' },
  { value: 'semverGt', label: 'version is above', kind: 'version' },
  { value: 'inSegment', label: 'is in segment', kind: 'segment' },
];

export const ATTRIBUTE_SUGGESTIONS = [
  'key',
  'email',
  'country',
  'plan',
  'groups',
  'appVersion',
  'org',
];

export function operatorKind(op: OperatorKey) {
  return OPERATORS.find((o) => o.value === op)?.kind ?? 'list';
}

let counter = 0;
/** Rule ids only need to be unique within a flag; a short random suffix does that. */
export function newRuleId(existing: readonly { id: string }[]): string {
  for (;;) {
    counter++;
    const id = `rule-${Math.random().toString(36).slice(2, 7)}${counter}`;
    if (!existing.some((r) => r.id === id)) return id;
  }
}

export function newClause(): AttributeClause {
  return { attribute: 'email', operator: 'endsWith', values: [''] };
}

export function newRule(existing: readonly Rule[], variants: readonly Variant[]): Rule {
  return {
    id: newRuleId(existing),
    clauses: [newClause()],
    serve: { variant: variants[0]?.key ?? 'on' },
  };
}

/** Even split, with any remainder on the first variant so the total is exact. */
export function evenRollout(variants: readonly Variant[]): Serve {
  const n = Math.max(1, variants.length);
  const each = Math.floor(ROLLOUT_TOTAL / n);
  return {
    rollout: {
      variants: variants.map((v, i) => ({
        variant: v.key,
        weight: i === 0 ? ROLLOUT_TOTAL - each * (n - 1) : each,
      })),
    },
  };
}

/** Rollout serving `onKey` to `percent` and `offKey` to the rest. */
export function twoWay(onKey: string, offKey: string, percent: number): Serve {
  const on = Math.round(Math.min(100, Math.max(0, percent)) * 1000);
  return {
    rollout: {
      variants: [
        { variant: onKey, weight: on },
        { variant: offKey, weight: ROLLOUT_TOTAL - on },
      ],
    },
  };
}

export function describeServe(serve: Serve): string {
  if ('variant' in serve) return serve.variant;
  return serve.rollout.variants.map((v) => `${v.variant} ${v.weight / 1000}%`).join(', ');
}
