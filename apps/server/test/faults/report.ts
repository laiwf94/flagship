import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const FAULTS = ['none', 'postgres-connections', 'listen-sessions', 'instance'] as const;
export type Fault = (typeof FAULTS)[number];

/** One round of the fault suite, in milliseconds from the fault. */
export interface Recovery {
  fault: Fault;
  round: number;
  /** Postgres sessions terminated, or client connections (streams and keep-alive) the killed instance held. */
  cut: number;
  /** From the fault to the first accepted write, and the attempts refused before it. */
  writeMs: number;
  failedWrites: number;
  /** From the fault until every SDK serves the value that write set. */
  propagatedMs: number;
  /** SDK clients that went `stale`, and from the fault until the last was `ready` again. */
  staleClients: number;
  readyMs: number;
  /** Evaluations that returned the caller's default during the round. */
  evaluationErrors: number;
}

export interface Spread {
  min: number;
  median: number;
  p95: number;
  max: number;
}

export interface FaultSummary {
  rounds: number;
  cut: Spread;
  writeMs: Spread;
  failedWrites: number;
  propagatedMs: Spread;
  staleClients: Spread;
  readyMs: Spread;
  evaluationErrors: number;
}

export interface Report {
  /** Bumped whenever a field changes meaning or goes away. */
  schema: 1;
  suite: 'faults';
  generatedAt: string;
  commit: string | null;
  environment: {
    node: string;
    platform: string;
    arch: string;
    cpus: number;
    cpuModel: string;
    memoryMiB: number;
    ci: boolean;
  };
  config: {
    instances: number;
    sdks: number;
    roundsPerFault: number;
    postgres: string;
  };
  faults: Record<Fault, FaultSummary>;
  rounds: Recovery[];
}

/** Nearest-rank percentile of a non-empty sorted list. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new Error('percentile of an empty list');
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

export function spread(values: readonly number[]): Spread {
  const sorted = [...values].sort((x, y) => x - y);
  return {
    min: sorted[0]!,
    median: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1]!,
  };
}

export function summarise(rs: readonly Recovery[]): FaultSummary {
  const of = (k: keyof Recovery) => rs.map((r) => r[k] as number);
  const sum = (k: keyof Recovery) => of(k).reduce((t, v) => t + v, 0);
  return {
    rounds: rs.length,
    cut: spread(of('cut')),
    writeMs: spread(of('writeMs')),
    failedWrites: sum('failedWrites'),
    propagatedMs: spread(of('propagatedMs')),
    staleClients: spread(of('staleClients')),
    readyMs: spread(of('readyMs')),
    evaluationErrors: sum('evaluationErrors'),
  };
}

export interface ReportInput {
  rounds: readonly Recovery[];
  roundsPerFault: number;
  sdks: number;
  instances: number;
  postgres: string;
  now?: Date;
  commit?: string | null;
}

/**
 * Builds the published report. Throws unless every fault ran exactly
 * `roundsPerFault` rounds, so a run cut short never passes for a full one.
 */
export function buildReport(input: ReportInput): Report {
  const faults = {} as Record<Fault, FaultSummary>;
  for (const fault of FAULTS) {
    const rs = input.rounds.filter((r) => r.fault === fault);
    if (rs.length !== input.roundsPerFault) {
      throw new Error(`${fault}: ${rs.length} of ${input.roundsPerFault} rounds recorded`);
    }
    faults[fault] = summarise(rs);
  }
  if (input.rounds.length !== FAULTS.length * input.roundsPerFault) {
    throw new Error(`unknown fault in ${input.rounds.length} rounds`);
  }
  const cpus = os.cpus();
  return {
    schema: 1,
    suite: 'faults',
    generatedAt: (input.now ?? new Date()).toISOString(),
    commit: input.commit === undefined ? currentCommit() : input.commit,
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpus: cpus.length,
      cpuModel: cpus[0]?.model.trim() ?? 'unknown',
      memoryMiB: Math.round(os.totalmem() / 2 ** 20),
      ci: process.env.CI === 'true',
    },
    config: {
      instances: input.instances,
      sdks: input.sdks,
      roundsPerFault: input.roundsPerFault,
      postgres: input.postgres,
    },
    faults,
    rounds: [...input.rounds],
  };
}

function currentCommit(): string | null {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch {
    return null;
  }
}

/** Writes the report atomically, so a reader never sees half a file. */
export function writeReport(file: string, report: Report): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`);
  renameSync(tmp, file);
}

const ms = (n: number) => String(Math.round(n));

/** A Markdown table of the per-fault summary, for a CI job summary. */
export function markdown(report: Report): string {
  const { config, environment } = report;
  const lines = [
    '### Fault recovery',
    '',
    `${config.instances} instances, ${config.sdks} SDK clients, ${config.roundsPerFault} rounds per fault; ` +
      `Node ${environment.node.replace(/^v/, '')}, ${environment.cpus} × ${environment.cpuModel}, ${config.postgres}.`,
    'Milliseconds from the fault, median / p95 / max.',
    '',
    '| Fault | Cut | First accepted write | Refused writes | Every SDK has the change | Stale SDKs | All SDKs ready | Default evaluations |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  const s = (x: Spread) => `${ms(x.median)} / ${ms(x.p95)} / ${ms(x.max)}`;
  for (const fault of FAULTS) {
    const f = report.faults[fault];
    lines.push(
      `| ${fault} | ${f.cut.median} | ${s(f.writeMs)} | ${f.failedWrites} | ${s(f.propagatedMs)} | ` +
        `${f.staleClients.max} | ${s(f.readyMs)} | ${f.evaluationErrors} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}
