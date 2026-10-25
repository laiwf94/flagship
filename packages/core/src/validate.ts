import type { z } from 'zod';
import { clauseValueProblems } from './operators.js';
import {
  LIMITS,
  flagSchema,
  own,
  rulesetSchema,
  segmentSchema,
  type Clause,
  type Flag,
  type Ruleset,
  type Segment,
  type Serve,
} from './model.js';

export interface ValidationIssue {
  /** Dotted path to the offending field, e.g. `flags.checkout.rules[2].clauses[0].values`. */
  path: string;
  message: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] };

type Path = readonly PropertyKey[];

export function formatPath(path: Path): string {
  let out = '';
  for (const part of path) {
    if (typeof part === 'number') out += `[${part}]`;
    else out += out === '' ? String(part) : `.${String(part)}`;
  }
  return out;
}

class Issues {
  readonly list: ValidationIssue[] = [];
  add(path: Path, message: string): void {
    this.list.push({ path: formatPath(path), message });
  }
}

function fromZod(error: z.ZodError, prefix: Path = []): ValidationIssue[] {
  return error.issues.map((i) => ({
    path: formatPath([...prefix, ...i.path]),
    message: i.message,
  }));
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) dup.add(v);
    seen.add(v);
  }
  return [...dup];
}

function checkVariantValue(flag: Flag, index: number, issues: Issues): void {
  const variant = flag.variants[index];
  if (variant === undefined) return;
  const path = ['variants', index, 'value'];
  const value = variant.value;
  switch (flag.type) {
    case 'boolean':
      if (typeof value !== 'boolean') issues.add(path, 'must be true or false for a boolean flag');
      break;
    case 'number':
      if (typeof value !== 'number') issues.add(path, 'must be a number for a number flag');
      break;
    case 'string':
      if (typeof value !== 'string') issues.add(path, 'must be a string for a string flag');
      else if (value.length > LIMITS.stringValueLength)
        issues.add(path, `must be at most ${LIMITS.stringValueLength} characters`);
      break;
    case 'json':
      if (JSON.stringify(value).length > LIMITS.jsonValueBytes)
        issues.add(path, `must serialize to at most ${LIMITS.jsonValueBytes} bytes`);
      break;
  }
}

function checkServe(serve: Serve, variants: ReadonlySet<string>, path: Path, issues: Issues): void {
  if ('variant' in serve) {
    if (!variants.has(serve.variant))
      issues.add([...path, 'variant'], `unknown variant "${serve.variant}"`);
    return;
  }
  serve.rollout.variants.forEach((wv, i) => {
    if (!variants.has(wv.variant))
      issues.add([...path, 'rollout', 'variants', i, 'variant'], `unknown variant "${wv.variant}"`);
  });
  for (const d of duplicates(serve.rollout.variants.map((v) => v.variant)))
    issues.add([...path, 'rollout', 'variants'], `variant "${d}" appears more than once`);
}

function checkClauses(clauses: readonly Clause[], path: Path, issues: Issues): void {
  clauses.forEach((clause, c) => {
    if (clause.operator === 'inSegment') return;
    for (const [i, message] of clauseValueProblems(clause)) {
      issues.add([...path, c, 'values', ...(i === undefined ? [] : [i])], message);
    }
  });
}

/** Checks inside one flag that don't depend on other flags or segments. */
function checkFlag(flag: Flag, issues: Issues): void {
  const keys = flag.variants.map((v) => v.key);
  for (const d of duplicates(keys)) issues.add(['variants'], `duplicate variant key "${d}"`);
  flag.variants.forEach((_, i) => {
    checkVariantValue(flag, i, issues);
  });
  if (flag.type === 'boolean') {
    const values = flag.variants.map((v) => v.value);
    if (flag.variants.length !== 2 || !values.includes(true) || !values.includes(false))
      issues.add(['variants'], 'a boolean flag has exactly two variants, true and false');
  }

  const variants = new Set(keys);
  if (!variants.has(flag.offVariant))
    issues.add(['offVariant'], `unknown variant "${flag.offVariant}"`);
  checkServe(flag.fallthrough, variants, ['fallthrough'], issues);
  flag.rules.forEach((rule, i) => {
    checkClauses(rule.clauses, ['rules', i, 'clauses'], issues);
    checkServe(rule.serve, variants, ['rules', i, 'serve'], issues);
  });
  for (const d of duplicates(flag.rules.map((r) => r.id)))
    issues.add(['rules'], `duplicate rule id "${d}"`);

  flag.prerequisites.forEach((p, i) => {
    if (p.flag === flag.key)
      issues.add(['prerequisites', i, 'flag'], 'a flag cannot be its own prerequisite');
  });
  for (const d of duplicates(flag.prerequisites.map((p) => p.flag)))
    issues.add(['prerequisites'], `prerequisite "${d}" is listed more than once`);
}

function checkSegment(segment: Segment, issues: Issues): void {
  segment.rules.forEach((rule, i) => {
    checkClauses(rule.clauses, ['rules', i, 'clauses'], issues);
  });
  for (const d of duplicates(segment.rules.map((r) => r.id)))
    issues.add(['rules'], `duplicate rule id "${d}"`);
}

function scoped(prefix: Path, run: (issues: Issues) => void, into: Issues): void {
  const inner = new Issues();
  run(inner);
  for (const issue of inner.list) {
    const head = formatPath(prefix);
    const sep = issue.path.startsWith('[') ? '' : '.';
    into.list.push({ path: `${head}${sep}${issue.path}`, message: issue.message });
  }
}

/** Validates one flag on its own: shape, variant types and variant references. */
export function validateFlag(input: unknown): ValidationResult<Flag> {
  const parsed = flagSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: fromZod(parsed.error) };
  const issues = new Issues();
  checkFlag(parsed.data, issues);
  return issues.list.length > 0
    ? { ok: false, issues: issues.list }
    : { ok: true, value: parsed.data };
}

export function validateSegment(input: unknown): ValidationResult<Segment> {
  const parsed = segmentSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: fromZod(parsed.error) };
  const issues = new Issues();
  checkSegment(parsed.data, issues);
  return issues.list.length > 0
    ? { ok: false, issues: issues.list }
    : { ok: true, value: parsed.data };
}

/**
 * Validates a whole ruleset, including references between flags and segments.
 * The server runs this on the candidate ruleset before committing any edit, so
 * a stored ruleset is always valid; SDKs run it again on every snapshot.
 */
export function validateRuleset(input: unknown): ValidationResult<Ruleset> {
  const parsed = rulesetSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: fromZod(parsed.error) };
  const ruleset = parsed.data;
  const issues = new Issues();

  const flagKeys = Object.keys(ruleset.flags);
  const segmentKeys = Object.keys(ruleset.segments);
  if (flagKeys.length > LIMITS.flagsPerRuleset)
    issues.add(['flags'], `at most ${LIMITS.flagsPerRuleset} flags per environment`);
  if (segmentKeys.length > LIMITS.segmentsPerRuleset)
    issues.add(['segments'], `at most ${LIMITS.segmentsPerRuleset} segments per environment`);

  for (const key of segmentKeys) {
    const segment = own(ruleset.segments, key);
    if (segment === undefined) continue;
    if (segment.key !== key)
      issues.add(['segments', key, 'key'], `must equal its map key "${key}"`);
    scoped(
      ['segments', key],
      (inner) => {
        checkSegment(segment, inner);
      },
      issues,
    );
  }

  for (const key of flagKeys) {
    const flag = own(ruleset.flags, key);
    if (flag === undefined) continue;
    if (flag.key !== key) issues.add(['flags', key, 'key'], `must equal its map key "${key}"`);
    scoped(
      ['flags', key],
      (inner) => {
        checkFlag(flag, inner);
      },
      issues,
    );
    checkReferences(ruleset, flag, issues);
  }

  if (issues.list.length === 0) checkPrerequisiteGraph(ruleset, issues);

  return issues.list.length > 0 ? { ok: false, issues: issues.list } : { ok: true, value: ruleset };
}

/**
 * Rejects prerequisite cycles and chains longer than LIMITS.prerequisiteDepth
 * flags. Runs only once references are known to be valid, so every edge
 * points at an existing flag.
 */
function checkPrerequisiteGraph(ruleset: Ruleset, issues: Issues): void {
  const state = new Map<string, 'visiting' | 'done'>();
  const depth = new Map<string, number>();
  const path: string[] = [];

  const visit = (key: string): void => {
    state.set(key, 'visiting');
    path.push(key);
    let deepest = 0;
    for (const p of own(ruleset.flags, key)?.prerequisites ?? []) {
      const seen = state.get(p.flag);
      if (seen === 'visiting') {
        const cycle = [...path.slice(path.indexOf(p.flag)), p.flag].join(' -> ');
        issues.add(['flags', key, 'prerequisites'], `prerequisites form a cycle: ${cycle}`);
        continue;
      }
      if (seen === undefined) visit(p.flag);
      deepest = Math.max(deepest, depth.get(p.flag) ?? 0);
    }
    path.pop();
    state.set(key, 'done');
    depth.set(key, deepest + 1);
  };

  for (const key of Object.keys(ruleset.flags)) {
    if (!state.has(key)) visit(key);
    if ((depth.get(key) ?? 0) > LIMITS.prerequisiteDepth) {
      issues.add(
        ['flags', key, 'prerequisites'],
        `prerequisite chain is longer than ${LIMITS.prerequisiteDepth} flags`,
      );
    }
  }
}

function checkReferences(ruleset: Ruleset, flag: Flag, issues: Issues): void {
  flag.rules.forEach((rule, r) => {
    rule.clauses.forEach((clause, c) => {
      if (clause.operator !== 'inSegment') return;
      clause.segments.forEach((s, i) => {
        if (own(ruleset.segments, s) === undefined)
          issues.add(
            ['flags', flag.key, 'rules', r, 'clauses', c, 'segments', i],
            `unknown segment "${s}"`,
          );
      });
    });
  });
  flag.prerequisites.forEach((p, i) => {
    const target = own(ruleset.flags, p.flag);
    const path = ['flags', flag.key, 'prerequisites', i];
    if (target === undefined) issues.add([...path, 'flag'], `unknown flag "${p.flag}"`);
    else if (!target.variants.some((v) => v.key === p.variant))
      issues.add([...path, 'variant'], `flag "${p.flag}" has no variant "${p.variant}"`);
  });
}
