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

/** One clause of a rule and whether the context matched it. */
export interface ClauseTrace {
  clause: Clause;
  matched: boolean;
  /** For an inSegment clause: each segment, whether it exists and whether the context is in it. */
  segments?: { key: string; found: boolean; matched: boolean }[];
}

/** Where a percentage split put the context. */
export interface BucketTrace {
  /** The string the context was bucketed by: its key, or the bucketBy attribute. */
  bucketBy: string;
  value: string;
  /** 0 to ROLLOUT_TOTAL - 1. */
  bucket: number;
}

/** One step of an evaluation, in the order evaluate() takes them. */
export type TraceStep =
  | { step: 'killSwitch'; enabled: boolean }
  | {
      step: 'prerequisite';
      flag: string;
      expected: string;
      /** The variant the prerequisite served, or null when it is missing or errored. */
      actual: string | null;
      /** False when the prerequisite flag is off, even if its off variant is the one expected. */
      enabled: boolean;
      passed: boolean;
    }
  | {
      step: 'rule';
      index: number;
      id: string;
      description?: string;
      matched: boolean;
      /** Every clause is shown, including those after the first that failed. */
      clauses: ClauseTrace[];
      bucket?: BucketTrace;
    }
  | { step: 'fallthrough'; bucket?: BucketTrace };

export interface Explanation {
  /** Exactly what evaluate() returns for the same arguments. */
  evaluation: Evaluation;
  /** The steps taken; rules after the first match are not reached and not listed. */
  trace: TraceStep[];
}

function traceClause(ruleset: Ruleset, clause: Clause, context: Context): ClauseTrace {
  if (clause.operator !== 'inSegment') {
    return { clause, matched: matchAttributeClause(clause, context) };
  }
  const segments = clause.segments.map((key) => {
    const segment = own(ruleset.segments, key);
    return {
      key,
      found: segment !== undefined,
      matched: segment !== undefined && inSegment(segment, context),
    };
  });
  const hit = segments.some((s) => s.matched);
  return { clause, matched: clause.negate === true ? !hit : hit, segments };
}

function traceBucket(flag: Flag, serve: Serve, context: Context): BucketTrace | undefined {
  if ('variant' in serve) return undefined;
  const value = bucketValue(context, serve.rollout.bucketBy);
  return {
    bucketBy: serve.rollout.bucketBy ?? 'key',
    value,
    bucket: bucketOf(flag.salt, value),
  };
}

/**
 * Evaluates one flag like evaluate() and records why: the kill switch, each
 * prerequisite, each rule tried with every clause's result, and the bucket a
 * split put the context in. For support and the CLI, not for hot paths: it
 * allocates a trace on every call.
 */
export function explain(ruleset: Ruleset, flagKey: string, context: unknown): Explanation {
  const trace: TraceStep[] = [];
  const flag = own(ruleset.flags, flagKey);
  if (flag === undefined)
    return { evaluation: error('FLAG_NOT_FOUND', `no flag "${flagKey}"`), trace };
  if (!isContext(context)) {
    return {
      evaluation: error(
        'INVALID_CONTEXT',
        'context must be an object with a non-empty string "key"',
      ),
      trace,
    };
  }
  const done = (evaluation: Evaluation): Explanation => ({ evaluation, trace });

  trace.push({ step: 'killSwitch', enabled: flag.enabled });
  if (!flag.enabled) return done(serveVariant(flag, flag.offVariant, 'DISABLED'));

  const stack = [flag.key];
  for (const prerequisite of flag.prerequisites) {
    if (stack.includes(prerequisite.flag) || stack.length >= LIMITS.prerequisiteDepth) {
      return done(
        error(
          'PREREQUISITE_CYCLE',
          `prerequisites of "${flag.key}" form a cycle or are nested too deeply`,
        ),
      );
    }
    const target = own(ruleset.flags, prerequisite.flag);
    if (target === undefined) {
      trace.push({
        step: 'prerequisite',
        flag: prerequisite.flag,
        expected: prerequisite.variant,
        actual: null,
        enabled: false,
        passed: false,
      });
      return done(serveVariant(flag, flag.offVariant, 'PREREQUISITE_FAILED'));
    }
    const result = evaluateFlag(ruleset, target, context, [...stack, target.key]);
    const actual = result.reason === 'ERROR' ? null : result.variant;
    const passed = target.enabled && actual === prerequisite.variant;
    trace.push({
      step: 'prerequisite',
      flag: prerequisite.flag,
      expected: prerequisite.variant,
      actual,
      enabled: target.enabled,
      passed,
    });
    if (result.reason === 'ERROR') return done(result);
    if (!passed) return done(serveVariant(flag, flag.offVariant, 'PREREQUISITE_FAILED'));
  }

  for (const [index, rule] of flag.rules.entries()) {
    const clauses = rule.clauses.map((c) => traceClause(ruleset, c, context));
    const matched = clauses.every((c) => c.matched);
    const step: Extract<TraceStep, { step: 'rule' }> = {
      step: 'rule',
      index,
      id: rule.id,
      matched,
      clauses,
    };
    if (rule.description !== undefined) step.description = rule.description;
    trace.push(step);
    if (matched) {
      const bucket = traceBucket(flag, rule.serve, context);
      if (bucket !== undefined) step.bucket = bucket;
      return done(
        serveVariant(flag, resolveServe(flag, rule.serve, context), 'TARGETING_MATCH', rule.id),
      );
    }
  }

  const step: Extract<TraceStep, { step: 'fallthrough' }> = { step: 'fallthrough' };
  const bucket = traceBucket(flag, flag.fallthrough, context);
  if (bucket !== undefined) step.bucket = bucket;
  trace.push(step);
  const reason = 'variant' in flag.fallthrough ? 'DEFAULT' : 'SPLIT';
  return done(serveVariant(flag, resolveServe(flag, flag.fallthrough, context), reason));
}
