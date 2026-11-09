import type { Flag, Serve } from './model.js';

/**
 * Where a flag is in its life in one environment.
 *
 * - `new`: created recently and not evaluated there yet.
 * - `active`: evaluated recently and still serving more than one variant, or
 *   changed recently.
 * - `launched`: everyone gets the same variant and the targeting hasn't
 *   changed for the stale window, so the flag can be removed from code.
 * - `inactive`: nothing has evaluated it for the stale window.
 * - `archived`: archived in the project.
 *
 * `launched` and `inactive` are stale: the flag is a cleanup candidate.
 */
export type LifecycleStage = 'new' | 'active' | 'launched' | 'inactive' | 'archived';

export const LIFECYCLE_STAGES: readonly LifecycleStage[] = [
  'new',
  'active',
  'launched',
  'inactive',
  'archived',
];

/** Days without a change or an evaluation before a flag counts as stale. */
export const STALE_AFTER_DAYS = 30;

const DAY = 86_400_000;

export type StaleReason =
  | {
      kind: 'launched';
      /** The one variant everyone gets. */
      variant: string;
      /** False when the kill switch is off and everyone gets the off variant. */
      enabled: boolean;
      /** When the targeting last changed, ISO 8601. */
      since: string;
    }
  | {
      kind: 'unevaluated';
      /** The last evaluation, or null if there was none since the flag was created. */
      lastEvaluatedAt: string | null;
      /** Since when nothing evaluated it: the last evaluation or the flag's creation. */
      since: string;
    };

export interface Lifecycle {
  stage: LifecycleStage;
  /** True for `launched` and `inactive`. */
  stale: boolean;
  /** Why the flag is stale; empty unless it is. Both apply when it is launched and unused. */
  reasons: StaleReason[];
}

export interface LifecycleInput {
  /** The flag's targeting in this environment. */
  config: Pick<Flag, 'enabled' | 'offVariant' | 'prerequisites' | 'rules' | 'fallthrough'>;
  archived: boolean;
  /** When the flag was created, epoch milliseconds. */
  createdAt: number;
  /** When the targeting in this environment last changed, epoch milliseconds. */
  targetingChangedAt: number;
  /** The last evaluation seen in this environment, epoch milliseconds, or null. */
  lastEvaluatedAt: number | null;
  now: number;
  staleAfterDays?: number;
  /**
   * How coarse `lastEvaluatedAt` is: a time stored as the start of its hour
   * has a resolution of an hour, and an evaluation in the hour the flag was
   * created then still counts as after its creation.
   */
  evaluationResolutionMs?: number;
}

function serveVariants(serve: Serve, out: Set<string>): void {
  if ('variant' in serve) {
    out.add(serve.variant);
    return;
  }
  for (const v of serve.rollout.variants) if (v.weight > 0) out.add(v.variant);
}

/**
 * Every variant the targeting can serve, whatever the context: the off
 * variant when the flag is off or a prerequisite can fail, each rule's
 * variants and the default rule's. A rollout counts only variants with a
 * non-zero weight, so a rollout finished at 100% serves one variant.
 */
export function reachableVariants(config: LifecycleInput['config']): Set<string> {
  const out = new Set<string>();
  if (!config.enabled) {
    out.add(config.offVariant);
    return out;
  }
  if (config.prerequisites.length > 0) out.add(config.offVariant);
  for (const rule of config.rules) serveVariants(rule.serve, out);
  serveVariants(config.fallthrough, out);
  return out;
}

/**
 * Classifies a flag in one environment. Evaluations older than the flag are
 * ignored, so a key that was deleted and created again starts fresh.
 */
export function lifecycleOf(input: LifecycleInput): Lifecycle {
  if (input.archived) return { stage: 'archived', stale: false, reasons: [] };
  const window = (input.staleAfterDays ?? STALE_AFTER_DAYS) * DAY;
  const lastEvaluated =
    input.lastEvaluatedAt !== null &&
    input.lastEvaluatedAt + (input.evaluationResolutionMs ?? 0) >= input.createdAt
      ? input.lastEvaluatedAt
      : null;
  const reasons: StaleReason[] = [];

  const unusedSince = lastEvaluated ?? input.createdAt;
  const unused = input.now - unusedSince >= window;
  if (unused) {
    reasons.push({
      kind: 'unevaluated',
      lastEvaluatedAt: lastEvaluated === null ? null : new Date(lastEvaluated).toISOString(),
      since: new Date(unusedSince).toISOString(),
    });
  }

  const served = reachableVariants(input.config);
  const settled = input.now - input.targetingChangedAt >= window;
  const only = served.size === 1 ? [...served][0] : undefined;
  if (only !== undefined && settled) {
    reasons.push({
      kind: 'launched',
      variant: only,
      enabled: input.config.enabled,
      since: new Date(input.targetingChangedAt).toISOString(),
    });
  }

  if (unused) return { stage: 'inactive', stale: true, reasons };
  if (reasons.length > 0) return { stage: 'launched', stale: true, reasons };
  if (lastEvaluated === null) return { stage: 'new', stale: false, reasons };
  return { stage: 'active', stale: false, reasons };
}

/** One line a person can read, such as "Serves on to everyone since 2026-10-01". */
export function describeReason(reason: StaleReason): string {
  const day = reason.since.slice(0, 10);
  if (reason.kind === 'launched') {
    return reason.enabled
      ? `Serves ${reason.variant} to everyone, unchanged since ${day}`
      : `Switched off (serves ${reason.variant} to everyone) since ${day}`;
  }
  return reason.lastEvaluatedAt === null
    ? `Never evaluated since it was created on ${day}`
    : `Not evaluated since ${day}`;
}
