import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluate } from '@flagship/core';
import { describe, expect, it } from 'vitest';
import { loadCases, mismatch, toObserved } from './index.js';

const cases = loadCases();

describe('conformance cases', () => {
  it('cover every reason and every operator', () => {
    const reasons = new Set(cases.flatMap((c) => c.tests.map((t) => t.expect.reason)));
    expect([...reasons].sort()).toEqual(
      ['DEFAULT', 'DISABLED', 'ERROR', 'PREREQUISITE_FAILED', 'SPLIT', 'TARGETING_MATCH'].sort(),
    );
    const operators = new Set(
      cases.flatMap((c) =>
        Object.values(c.ruleset.flags).flatMap((f) =>
          f.rules.flatMap((r) => r.clauses.map((cl) => cl.operator)),
        ),
      ),
    );
    expect(operators.size).toBe(14);
  });
});

describe.each(cases)('core evaluator: $name', ({ ruleset, tests }) => {
  it.each(tests)('$name', ({ flag, context, expect: expected }) => {
    expect(mismatch(expected, toObserved(evaluate(ruleset, flag, context)))).toBeUndefined();
  });
});

describe('loadCases', () => {
  it('refuses a case whose ruleset would not be accepted by the server', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cases-'));
    writeFileSync(
      join(dir, 'bad.json'),
      JSON.stringify({
        name: 'bad',
        description: '',
        ruleset: { environment: 'x', version: 1, flags: { a: { key: 'b' } }, segments: {} },
        tests: [],
      }),
    );
    expect(() => loadCases(dir)).toThrow(/bad\.json: invalid ruleset/);
  });

  it('reports mismatches in a readable form', () => {
    expect(
      mismatch(
        { reason: 'DEFAULT', variant: 'on', value: true },
        { reason: 'ERROR', errorCode: 'FLAG_NOT_FOUND' },
      ),
    ).toBe(
      'expected {"reason":"DEFAULT","variant":"on","value":true}, got {"reason":"ERROR","errorCode":"FLAG_NOT_FOUND"}',
    );
    expect(toObserved({ reason: 'ERROR', errorCode: 'FLAG_NOT_FOUND', message: 'x' })).toEqual({
      reason: 'ERROR',
      errorCode: 'FLAG_NOT_FOUND',
    });
  });
});
