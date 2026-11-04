import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildReport,
  FAULTS,
  markdown,
  percentile,
  spread,
  summarise,
  writeReport,
  type Recovery,
} from './report.js';

function round(fault: Recovery['fault'], n: number, over: Partial<Recovery> = {}): Recovery {
  return {
    fault,
    round: n,
    cut: 4,
    writeMs: 10 * n,
    failedWrites: 0,
    propagatedMs: 100 * n,
    staleClients: 0,
    readyMs: 0,
    evaluationErrors: 0,
    ...over,
  };
}

const full = (rounds: number) =>
  FAULTS.flatMap((f) => Array.from({ length: rounds }, (_, i) => round(f, i + 1)));

describe('percentile', () => {
  it('uses the nearest rank', () => {
    const xs = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(xs, 50)).toBe(10);
    expect(percentile(xs, 95)).toBe(19);
    expect(percentile(xs, 100)).toBe(20);
    expect(percentile(xs, 0)).toBe(1);
    expect(percentile([7], 95)).toBe(7);
  });

  it('refuses an empty list', () => {
    expect(() => percentile([], 50)).toThrow(/empty/);
  });
});

describe('spread', () => {
  it('sorts before ranking and leaves the input alone', () => {
    const xs = [30, 10, 20];
    expect(spread(xs)).toEqual({ min: 10, median: 20, p95: 30, max: 30 });
    expect(xs).toEqual([30, 10, 20]);
  });
});

describe('summarise', () => {
  it('spreads the timings and totals the failures', () => {
    const s = summarise([
      round('instance', 1, { failedWrites: 2, staleClients: 18, readyMs: 900 }),
      round('instance', 2, {
        failedWrites: 1,
        staleClients: 22,
        readyMs: 1300,
        evaluationErrors: 1,
      }),
      round('instance', 3, { staleClients: 20, readyMs: 1100 }),
    ]);
    expect(s.rounds).toBe(3);
    expect(s.failedWrites).toBe(3);
    expect(s.evaluationErrors).toBe(1);
    expect(s.writeMs).toEqual({ min: 10, median: 20, p95: 30, max: 30 });
    expect(s.propagatedMs.median).toBe(200);
    expect(s.staleClients).toEqual({ min: 18, median: 20, p95: 22, max: 22 });
    expect(s.readyMs.max).toBe(1300);
  });
});

describe('buildReport', () => {
  const input = {
    roundsPerFault: 3,
    sdks: 40,
    instances: 2,
    postgres: 'PostgreSQL 17.6',
    now: new Date('2026-11-04T03:00:00Z'),
    commit: 'abc123',
  };

  it('describes the run and summarises every fault', () => {
    const r = buildReport({ ...input, rounds: full(3) });
    expect(r.schema).toBe(1);
    expect(r.suite).toBe('faults');
    expect(r.generatedAt).toBe('2026-11-04T03:00:00.000Z');
    expect(r.commit).toBe('abc123');
    expect(r.config).toEqual({
      instances: 2,
      sdks: 40,
      roundsPerFault: 3,
      postgres: 'PostgreSQL 17.6',
    });
    expect(r.environment.node).toBe(process.version);
    expect(r.environment.cpus).toBeGreaterThan(0);
    expect(Object.keys(r.faults)).toEqual([...FAULTS]);
    expect(r.faults['listen-sessions'].rounds).toBe(3);
    expect(r.rounds).toHaveLength(12);
  });

  it('finds the commit when none is given', () => {
    const { commit: _, ...rest } = input;
    const r = buildReport({ ...rest, rounds: full(3) });
    expect(r.commit === null || /^[0-9a-f]{40}$/.test(r.commit)).toBe(true);
  });

  it('refuses a run with a fault short of rounds', () => {
    const rounds = full(3).filter((r) => !(r.fault === 'instance' && r.round === 3));
    expect(() => buildReport({ ...input, rounds })).toThrow('instance: 2 of 3 rounds recorded');
  });

  it('refuses a run with a fault it does not know', () => {
    const rounds = [...full(3), round('bogus' as Recovery['fault'], 1)];
    expect(() => buildReport({ ...input, rounds })).toThrow(/unknown fault/);
  });
});

describe('writeReport and markdown', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('writes parseable JSON into a new directory, leaving no temporary file', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'faults-report-'));
    const file = path.join(dir, 'results', 'faults.json');
    const report = buildReport({
      rounds: full(2),
      roundsPerFault: 2,
      sdks: 40,
      instances: 2,
      postgres: 'PostgreSQL 17.6',
      commit: null,
    });
    writeReport(file, report);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(report);
    expect(readdirSync(path.dirname(file))).toEqual(['faults.json']);
  });

  it('renders one row per fault', () => {
    const report = buildReport({
      rounds: full(3),
      roundsPerFault: 3,
      sdks: 40,
      instances: 2,
      postgres: 'PostgreSQL 17.6',
      commit: null,
    });
    const md = markdown(report);
    const rows = md
      .split('\n')
      .filter((l) => l.startsWith('| ') && !l.startsWith('| Fault') && !l.startsWith('| ---'));
    expect(rows.map((l) => l.split(' | ')[0])).toEqual(FAULTS.map((f) => `| ${f}`));
    expect(md).toContain(
      '| instance | 4 | 20 / 30 / 30 | 0 | 200 / 300 / 300 | 0 | 0 / 0 / 0 | 0 |',
    );
    expect(md).toContain('2 instances, 40 SDK clients, 3 rounds per fault');
  });
});
