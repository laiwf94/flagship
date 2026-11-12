import {
  ROLLOUT_TOTAL,
  type Flag,
  type RolloutPlan,
  type RolloutStep,
  type RolloutTarget,
  type Serve,
} from './model.js';
import type { ValidationIssue } from './validate.js';

/** 1%, 5%, 10%, 25%, 50%, then everyone, an hour apart: the console's starting point. */
export const DEFAULT_ROLLOUT_STEPS: readonly RolloutStep[] = [
  { weight: 1_000, holdMinutes: 60 },
  { weight: 5_000, holdMinutes: 60 },
  { weight: 10_000, holdMinutes: 60 },
  { weight: 25_000, holdMinutes: 60 },
  { weight: 50_000, holdMinutes: 60 },
  { weight: ROLLOUT_TOTAL },
];

/** The part of a flag's targeting that a plan reads and writes. */
export type Targeting = Pick<Flag, 'rules' | 'fallthrough'>;

/**
 * What the target serves at step `index`. The rolled-out variant comes first,
 * so a context gets it exactly when its bucket is below the step's weight and
 * raising the weight only adds contexts. The last step serves the variant
 * outright, which leaves the flag plainly on rather than at a 100/0 split.
 */
export function stepServe(plan: RolloutPlan, index: number): Serve {
  const step = plan.steps[index];
  if (step === undefined) throw new RangeError(`plan has no step ${index}`);
  if (step.weight === ROLLOUT_TOTAL) return { variant: plan.variant };
  return {
    rollout: {
      ...(plan.bucketBy === undefined ? {} : { bucketBy: plan.bucketBy }),
      variants: [
        { variant: plan.variant, weight: step.weight },
        { variant: plan.baseline, weight: ROLLOUT_TOTAL - step.weight },
      ],
    },
  };
}

/** The serve at a target, or undefined when the targeted rule no longer exists. */
export function serveAt(targeting: Targeting, target: RolloutTarget): Serve | undefined {
  if (target === 'fallthrough') return targeting.fallthrough;
  return targeting.rules.find((r) => r.id === target.rule)?.serve;
}

/** Targeting with the serve at `target` replaced, or undefined when the rule is gone. */
export function withServeAt(
  targeting: Targeting,
  target: RolloutTarget,
  serve: Serve,
): Targeting | undefined {
  if (target === 'fallthrough') return { rules: targeting.rules, fallthrough: serve };
  const i = targeting.rules.findIndex((r) => r.id === target.rule);
  const rule = targeting.rules[i];
  if (rule === undefined) return undefined;
  const rules = targeting.rules.slice();
  rules[i] = { ...rule, serve };
  return { rules, fallthrough: targeting.fallthrough };
}

/**
 * Whether two serves bucket every context the same way. A missing `bucketBy`
 * and `bucketBy: "key"` are the same; weights compare in declared order,
 * because the order decides which bucket ranges each variant takes.
 */
export function sameServe(a: Serve, b: Serve): boolean {
  if ('variant' in a || 'variant' in b) {
    return 'variant' in a && 'variant' in b && a.variant === b.variant;
  }
  const by = (s: typeof a.rollout) => s.bucketBy ?? 'key';
  if (by(a.rollout) !== by(b.rollout)) return false;
  const av = a.rollout.variants;
  const bv = b.rollout.variants;
  return (
    av.length === bv.length &&
    av.every((v, i) => v.variant === bv[i]?.variant && v.weight === bv[i].weight)
  );
}

/** Problems with running `plan` on this flag: unknown variants or a missing rule. */
export function rolloutPlanIssues(
  plan: RolloutPlan,
  flag: Pick<Flag, 'variants'> & Targeting,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const known = new Set(flag.variants.map((v) => v.key));
  for (const field of ['variant', 'baseline'] as const) {
    if (!known.has(plan[field])) {
      issues.push({ path: field, message: `unknown variant "${plan[field]}"` });
    }
  }
  if (serveAt(flag, plan.target) === undefined && typeof plan.target === 'object') {
    issues.push({ path: 'target.rule', message: `unknown rule "${plan.target.rule}"` });
  }
  return issues;
}
