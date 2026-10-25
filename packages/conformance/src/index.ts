import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { validateRuleset, type Evaluation, type Ruleset } from '@flagship/core';

export interface ConformanceTest {
  name: string;
  flag: string;
  context: Record<string, unknown>;
  expect:
    { reason: string; variant: string; value: unknown } | { reason: 'ERROR'; errorCode: string };
}

export interface ConformanceCase {
  name: string;
  description: string;
  ruleset: Ruleset;
  tests: ConformanceTest[];
}

/** What an evaluator under test reports. Extra fields such as ruleId are ignored. */
export type Observed =
  { reason: string; variant: string; value: unknown } | { reason: 'ERROR'; errorCode: string };

export const casesDir = join(import.meta.dirname, '..', 'cases');

/**
 * Loads every case file. Rulesets are validated first: a case that the server
 * would refuse to store is a broken case, not a passing one.
 */
export function loadCases(dir: string = casesDir): ConformanceCase[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => {
      const raw = JSON.parse(readFileSync(join(dir, file), 'utf8')) as ConformanceCase;
      const valid = validateRuleset(raw.ruleset);
      if (!valid.ok) {
        const detail = valid.issues.map((i) => `${i.path}: ${i.message}`).join('; ');
        throw new Error(`${file}: invalid ruleset: ${detail}`);
      }
      return { ...raw, ruleset: valid.value };
    });
}

export function toObserved(e: Evaluation): Observed {
  return e.reason === 'ERROR'
    ? { reason: 'ERROR', errorCode: e.errorCode }
    : { reason: e.reason, variant: e.variant, value: e.value };
}

/** Returns a description of the mismatch, or undefined when they agree. */
export function mismatch(
  expected: ConformanceTest['expect'],
  observed: Observed,
): string | undefined {
  const pick = (o: Observed) =>
    o.reason === 'ERROR' && 'errorCode' in o
      ? { reason: o.reason, errorCode: o.errorCode }
      : {
          reason: o.reason,
          variant: (o as { variant: string }).variant,
          value: (o as { value: unknown }).value,
        };
  const a = JSON.stringify(pick(expected));
  const b = JSON.stringify(pick(observed));
  return a === b ? undefined : `expected ${a}, got ${b}`;
}
