import {
  own,
  type AttributeClause,
  type AttributeOperator,
  type ClauseValue,
  type Context,
  type ContextValue,
} from './model.js';
import { matchesPattern, patternProblem } from './regex.js';
import { compareSemver, parseSemver } from './semver.js';

type Scalar = Exclude<ContextValue, null | unknown[]>;

function matchOne(op: AttributeOperator, actual: Scalar, expected: ClauseValue): boolean {
  switch (op) {
    case 'equals':
    case 'in':
      return actual === expected;
    case 'contains':
      return (
        typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected)
      );
    case 'startsWith':
      return (
        typeof actual === 'string' && typeof expected === 'string' && actual.startsWith(expected)
      );
    case 'endsWith':
      return (
        typeof actual === 'string' && typeof expected === 'string' && actual.endsWith(expected)
      );
    case 'matches':
      return (
        typeof actual === 'string' &&
        typeof expected === 'string' &&
        matchesPattern(expected, actual)
      );
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      if (typeof actual !== 'number' || typeof expected !== 'number') return false;
      if (op === 'lt') return actual < expected;
      if (op === 'lte') return actual <= expected;
      if (op === 'gt') return actual > expected;
      return actual >= expected;
    }
    case 'semverEq':
    case 'semverLt':
    case 'semverGt': {
      if (typeof actual !== 'string' || typeof expected !== 'string') return false;
      const a = parseSemver(actual);
      const b = parseSemver(expected);
      if (a === undefined || b === undefined) return false;
      const c = compareSemver(a, b);
      return op === 'semverEq' ? c === 0 : op === 'semverLt' ? c < 0 : c > 0;
    }
  }
}

/**
 * True when any value of the attribute matches any value of the clause. A
 * list attribute such as `groups: ["beta", "staff"]` matches if any element
 * does. A missing or null attribute never matches, negated or not: "country is
 * not US" says nothing about someone whose country we don't know.
 */
export function matchAttributeClause(clause: AttributeClause, context: Context): boolean {
  const actual = own(context, clause.attribute);
  if (actual === undefined || actual === null) return false;
  const items: Scalar[] = Array.isArray(actual) ? actual : [actual];
  const hit = items.some((item) => clause.values.some((v) => matchOne(clause.operator, item, v)));
  return clause.negate === true ? !hit : hit;
}

/** Per-operator checks on clause values. Returns problems as [valueIndex | undefined, message]. */
export function clauseValueProblems(clause: AttributeClause): [number | undefined, string][] {
  const out: [number | undefined, string][] = [];
  const { operator: op, values } = clause;
  const single = () => {
    if (values.length !== 1) out.push([undefined, `"${op}" takes exactly one value`]);
  };
  switch (op) {
    case 'equals':
      single();
      break;
    case 'in':
      break;
    case 'contains':
    case 'startsWith':
    case 'endsWith':
      values.forEach((v, i) => {
        if (typeof v !== 'string' || v.length === 0) out.push([i, 'must be a non-empty string']);
      });
      break;
    case 'matches':
      values.forEach((v, i) => {
        if (typeof v !== 'string') {
          out.push([i, 'must be a pattern string']);
          return;
        }
        const problem = patternProblem(v);
        if (problem !== undefined) out.push([i, `invalid pattern: ${problem}`]);
      });
      break;
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      single();
      values.forEach((v, i) => {
        if (typeof v !== 'number') out.push([i, 'must be a number']);
      });
      break;
    case 'semverEq':
    case 'semverLt':
    case 'semverGt':
      single();
      values.forEach((v, i) => {
        if (typeof v !== 'string' || parseSemver(v) === undefined) {
          out.push([i, 'must be a semantic version such as 2.4.0']);
        }
      });
      break;
  }
  return out;
}
