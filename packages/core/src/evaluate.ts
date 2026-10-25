import { bucketOf, bucketValue, pickVariant } from './bucket.js';
import {
  LIMITS,
  own,
  type Clause,
  type Context,
  type Flag,
  type Ruleset,
  type Segment,
  type Serve,
} from './model.js';
import { matchAttributeClause } from './operators.js';

type JsonValue = Flag['variants'][number]['value'];

/** Why a context got the value it got. Names follow the OpenFeature specification. */
export type Reason = 'DISABLED' | 'PREREQUISITE_FAILED' | 'TARGETING_MATCH' | 'SPLIT' | 'DEFAULT';

export type ErrorCode =
  'FLAG_NOT_FOUND' | 'INVALID_CONTEXT' | 'PREREQUISITE_CYCLE' | 'MALFORMED_FLAG';

export type Evaluation =
  | { reason: Reason; variant: string; value: JsonValue; ruleId?: string }
  | { reason: 'ERROR'; errorCode: ErrorCode; message: string };

interface SegmentIndex {
  included: ReadonlySet<string>;
  excluded: ReadonlySet<string>;
}

// Segment member lists can hold 10,000 keys; index them once per segment object.
const segmentIndexes = new WeakMap<Segment, SegmentIndex>();

function indexOf(segment: Segment): SegmentIndex {
  let index = segmentIndexes.get(segment);
  if (index === undefined) {
    index = { included: new Set(segment.included), excluded: new Set(segment.excluded) };
    segmentIndexes.set(segment, index);
  }
  return index;
}

/** Exclusion wins over inclusion and over rules: it is the explicit "never this person". */
export function inSegment(segment: Segment, context: Context): boolean {
  const index = indexOf(segment);
  if (index.excluded.has(context.key)) return false;
  if (index.included.has(context.key)) return true;
  return segment.rules.some((rule) => rule.clauses.every((c) => matchAttributeClause(c, context)));
}

function matchClause(ruleset: Ruleset, clause: Clause, context: Context): boolean {
  if (clause.operator !== 'inSegment') return matchAttributeClause(clause, context);
  const hit = clause.segments.some((key) => {
    const segment = own(ruleset.segments, key);
    return segment !== undefined && inSegment(segment, context);
  });
  return clause.negate === true ? !hit : hit;
}

function error(errorCode: ErrorCode, message: string): Evaluation {
  return { reason: 'ERROR', errorCode, message };
}

function serveVariant(
  flag: Flag,
  variant: string | undefined,
  reason: Reason,
  ruleId?: string,
): Evaluation {
  const found = flag.variants.find((v) => v.key === variant);
  if (found === undefined) {
    return error('MALFORMED_FLAG', `flag "${flag.key}" refers to a missing variant`);
  }
  const result: Evaluation = { reason, variant: found.key, value: found.value };
  if (ruleId !== undefined) result.ruleId = ruleId;
  return result;
}

function resolveServe(flag: Flag, serve: Serve, context: Context): string | undefined {
  if ('variant' in serve) return serve.variant;
  const bucket = bucketOf(flag.salt, bucketValue(context, serve.rollout.bucketBy));
  return pickVariant(serve.rollout, bucket);
}

function evaluateFlag(
  ruleset: Ruleset,
  flag: Flag,
  context: Context,
  stack: readonly string[],
): Evaluation {
  if (!flag.enabled) return serveVariant(flag, flag.offVariant, 'DISABLED');

  for (const prerequisite of flag.prerequisites) {
    if (stack.includes(prerequisite.flag) || stack.length >= LIMITS.prerequisiteDepth) {
      return error(
        'PREREQUISITE_CYCLE',
        `prerequisites of "${flag.key}" form a cycle or are nested too deeply`,
      );
    }
    const target = own(ruleset.flags, prerequisite.flag);
    if (target === undefined) return serveVariant(flag, flag.offVariant, 'PREREQUISITE_FAILED');
    const result = evaluateFlag(ruleset, target, context, [...stack, target.key]);
    if (result.reason === 'ERROR') return result;
    if (!target.enabled || result.variant !== prerequisite.variant) {
      return serveVariant(flag, flag.offVariant, 'PREREQUISITE_FAILED');
    }
  }

  for (const rule of flag.rules) {
    if (rule.clauses.every((c) => matchClause(ruleset, c, context))) {
      return serveVariant(
        flag,
        resolveServe(flag, rule.serve, context),
        'TARGETING_MATCH',
        rule.id,
      );
    }
  }

  const reason = 'variant' in flag.fallthrough ? 'DEFAULT' : 'SPLIT';
  return serveVariant(flag, resolveServe(flag, flag.fallthrough, context), reason);
}

function isContext(context: unknown): context is Context {
  return (
    typeof context === 'object' &&
    context !== null &&
    !Array.isArray(context) &&
    typeof (context as { key?: unknown }).key === 'string' &&
    (context as { key: string }).key.length > 0
  );
}

/**
 * Evaluates one flag for one context. Never throws: problems come back as
 * reason "ERROR" so the caller can fall back to its own default.
 *
 * Order: kill switch, then prerequisites, then rules top to bottom (first
 * match wins), then the default rule.
 */
export function evaluate(ruleset: Ruleset, flagKey: string, context: unknown): Evaluation {
  const flag = own(ruleset.flags, flagKey);
  if (flag === undefined) return error('FLAG_NOT_FOUND', `no flag "${flagKey}"`);
  if (!isContext(context)) {
    return error('INVALID_CONTEXT', 'context must be an object with a non-empty string "key"');
  }
  return evaluateFlag(ruleset, flag, context, [flag.key]);
}

/** Evaluates every flag that passes `include`, e.g. the ones client-side keys may see. */
export function evaluateAll(
  ruleset: Ruleset,
  context: unknown,
  include: (flag: Flag) => boolean = () => true,
): Record<string, Evaluation> {
  const out: Record<string, Evaluation> = {};
  for (const flag of Object.values(ruleset.flags)) {
    if (include(flag)) out[flag.key] = evaluate(ruleset, flag.key, context);
  }
  return out;
}
