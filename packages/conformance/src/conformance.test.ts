import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RulesetDigest,
  canonicalJson,
  evaluate,
  evaluationChecksum,
  rulesetChecksum,
  validateFlag,
  validateSegment,
} from '@flagship/core';
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

describe('core checksums', () => {
  const withChecksums = cases.filter((c) => c.checksum !== undefined);

  it('are covered by at least one case with patches and canonical vectors', () => {
    expect(withChecksums.some((c) => (c.patches ?? []).length > 0)).toBe(true);
    expect(withChecksums.some((c) => (c.canonical ?? []).length > 0)).toBe(true);
  });

  it.each(withChecksums)('$name: the ruleset and every patch add up', (c) => {
    expect(rulesetChecksum(c.ruleset)).toBe(c.checksum);
    const digest = RulesetDigest.of(c.ruleset);
    for (const p of c.patches ?? []) {
      if (p.value !== null) {
        const valid = p.kind === 'flag' ? validateFlag(p.value) : validateSegment(p.value);
        expect(valid.ok, `patch ${p.version} is valid`).toBe(true);
      }
      digest.prepare(p.kind, p.key, p.value).apply();
      expect(digest.checksum, `after patch ${p.version}`).toBe(p.checksum);
    }
  });

  it.each(withChecksums)('$name: canonical JSON and SHA-256 vectors', (c) => {
    for (const v of c.canonical ?? []) {
      expect(canonicalJson(v.value)).toBe(v.json);
      expect(evaluationChecksum(v.value)).toBe(v.sha256);
    }
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
      'expected {"reason":"DEFAULT","value":true,"variant":"on"}, got {"errorCode":"FLAG_NOT_FOUND","reason":"ERROR"}',
    );
    expect(
      mismatch(
        { reason: 'DEFAULT', variant: 'a', value: { x: 1, y: [{ b: 2, a: 1 }] } },
        { reason: 'DEFAULT', variant: 'a', value: { y: [{ a: 1, b: 2 }], x: 1 } },
      ),
    ).toBeUndefined();
    expect(
      mismatch(
        { reason: 'DEFAULT', variant: 'a', value: [1, 2] },
        { reason: 'DEFAULT', variant: 'a', value: [2, 1] },
      ),
    ).toBe(
      'expected {"reason":"DEFAULT","value":[1,2],"variant":"a"}, got {"reason":"DEFAULT","value":[2,1],"variant":"a"}',
    );
    expect(toObserved({ reason: 'ERROR', errorCode: 'FLAG_NOT_FOUND', message: 'x' })).toEqual({
      reason: 'ERROR',
      errorCode: 'FLAG_NOT_FOUND',
    });
  });
});
