import { appendFileSync } from 'node:fs';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { createDatabase, migrate } from '../../src/db/database.js';
import { createTestDatabase } from '../db.js';
import { PASSWORD } from '../session.js';
import {
  Admin,
  Balancer,
  Fleet,
  Instance,
  retry,
  terminate,
  until,
  type Write,
} from './harness.js';
import { buildReport, markdown, writeReport, type Recovery } from './report.js';

/**
 * Fault injection under SDK traffic. Two real server processes share one
 * database behind a TCP load balancer, and 40 SDK clients evaluate a flag
 * through it in a loop. Each round breaks something, immediately retries a
 * kill-switch change until the API accepts it, and measures how long until
 * every SDK serves the new value.
 *
 * FLAGSHIP_FAULT_ROUNDS sets the rounds per fault (3). FLAGSHIP_FAULT_RESULTS
 * names a JSON file to write the report to when every test passed, as
 * `pnpm bench:faults` does; under GitHub Actions the summary table also goes
 * to the job summary.
 */

const ROUNDS = Number(process.env.FLAGSHIP_FAULT_ROUNDS ?? '3');
const SDKS = 40;
const FLAG = 'faults';
const EMAIL = 'root@example.com';
const P = '/api/projects/default';
const KILL = `${P}/flags/${FLAG}/environments/production/kill-switch`;

let database: string;
let a: Instance;
let b: Instance;
let balancer: Balancer;
let admin: Admin;
let fleet: Fleet;
/** Undone in reverse in afterAll, so a beforeAll that fails part way still cleans up. */
const cleanup: (() => Promise<void>)[] = [];
let sdkKey: string;
let serving = true;
const results: Recovery[] = [];
let postgres = 'unknown';
let failed = false;

beforeEach(({ onTestFailed }) => {
  onTestFailed(() => {
    failed = true;
  });
});

beforeAll(async () => {
  const created = await createTestDatabase();
  cleanup.push(created.drop);
  database = new URL(created.url).pathname.slice(1);
  // Migrate up front so the instances start in seconds, not one after another.
  const { db } = createDatabase({ url: created.url, maxConnections: 2 });
  await migrate(db);
  const version = await sql<{ server_version: string }>`show server_version`.execute(db);
  postgres = `PostgreSQL ${version.rows[0]!.server_version}`;
  await db.destroy();

  const env = {
    FLAGSHIP_ADMIN_EMAIL: EMAIL,
    FLAGSHIP_ADMIN_PASSWORD: PASSWORD,
    FLAGSHIP_LOG_LEVEL: 'warn',
    FLAGSHIP_EVENTS_FLUSH_MS: '200',
    FLAGSHIP_DB_POOL_SIZE: '10',
  };
  a = await Instance.create('faults-a', created.url, env);
  b = await Instance.create('faults-b', created.url, env);
  cleanup.push(
    () => a.kill(),
    () => b.kill(),
  );
  // The first one creates the admin and the default project.
  await a.start();
  await b.start();
  balancer = new Balancer([a, b]);
  await balancer.start();
  cleanup.push(() => balancer.close());

  admin = await Admin.signIn(balancer.url, EMAIL, PASSWORD);
  const res = await admin.request('POST', `${P}/flags`, {
    key: FLAG,
    name: 'Fault suite',
    type: 'boolean',
  });
  expect(res.status, res.body).toBe(201);
  const flag = (await admin.request('GET', `${P}/flags/${FLAG}`)).json();
  const targeting = await admin.request('PUT', `${P}/flags/${FLAG}/environments/production`, {
    version: flag.environments.production.version,
    enabled: true,
    offVariant: 'off',
    prerequisites: [],
    rules: [],
    fallthrough: { variant: 'on' },
  });
  expect(targeting.status, targeting.body).toBe(200);
  const key = await admin.request('POST', `${P}/environments/production/api-keys`, {
    kind: 'server',
    name: 'faults',
  });
  expect(key.status, key.body).toBe(201);

  sdkKey = key.json().secret;
  fleet = new Fleet(SDKS, balancer.url, sdkKey, FLAG);
  cleanup.push(() => fleet.close());
  await fleet.ready();
  fleet.start();
  await until('SDKs connected', () => fleet.allReady());
  expect(new Set(fleet.clients.map((c) => c.boolVariation(FLAG, { key: 'x' }, false)))).toEqual(
    new Set([true]),
  );
}, 120_000);

afterAll(async () => {
  // Every kill in the suite is followed by a restart, so a stopped instance crashed.
  for (const i of cleanup.length > 1 ? [a, b] : []) {
    if (!i.running) process.stdout.write(`${i.name} exited unexpectedly:\n${i.output.join('')}\n`);
  }
  for (const undo of cleanup.reverse()) await undo();
  if (results.length > 0) process.stdout.write(summary(results));
  publish();
});

function publish(): void {
  const file = process.env.FLAGSHIP_FAULT_RESULTS;
  if (!file) return;
  if (failed) {
    process.stdout.write(`Not writing ${file}: a test failed.\n`);
    return;
  }
  const report = buildReport({
    rounds: results,
    roundsPerFault: ROUNDS,
    sdks: SDKS,
    instances: 2,
    postgres,
  });
  writeReport(file, report);
  process.stdout.write(`Wrote ${file}\n`);
  const jobSummary = process.env.GITHUB_STEP_SUMMARY;
  if (jobSummary) appendFileSync(jobSummary, markdown(report));
}

/**
 * Injects a fault, then flips the kill switch (retrying until accepted) and
 * waits until every SDK serves the new value.
 */
async function round(
  fault: Recovery['fault'],
  n: number,
  inject: () => Promise<number>,
): Promise<Recovery> {
  await until('every SDK ready before the fault', () => fleet.allReady());
  const value = !serving;
  fleet.expect(value);
  const errorsBefore = fleet.errors;
  const cut = await inject();
  const t0 = performance.now();
  const write: Write = await retry(t0, () => admin.request('POST', KILL, { enabled: value }, 2000));
  serving = value;
  const propagatedMs = await fleet.converged(t0);
  await until('every SDK ready after the fault', () => fleet.allReady());
  const r: Recovery = {
    fault,
    round: n,
    cut,
    writeMs: round1(write.ms),
    failedWrites: write.failures,
    propagatedMs: round1(propagatedMs),
    staleClients: fleet.left.size,
    readyMs: fleet.left.size === 0 ? 0 : round1(fleet.backAt - t0),
    evaluationErrors: fleet.errors - errorsBefore,
  };
  results.push(r);
  return r;
}

const round1 = (ms: number) => Math.round(ms * 10) / 10;
const rounds = Array.from({ length: ROUNDS }, (_, i) => i + 1);
const timeout = 30_000 + ROUNDS * 20_000;

describe('recovery under SDK traffic', () => {
  it(
    'measures a change with nothing broken, for comparison',
    async () => {
      for (const n of rounds) {
        const r = await round('none', n, async () => 0);
        expect(r.failedWrites).toBe(0);
        expect(r.evaluationErrors).toBe(0);
        expect(r.staleClients).toBe(0);
        expect(r.propagatedMs).toBeLessThan(2000);
      }
    },
    timeout,
  );

  it(
    'replaces pooled Postgres connections that were killed, without touching streams',
    async () => {
      for (const n of rounds) {
        const r = await round('postgres-connections', n, () =>
          terminate(inject('postgresUrl'), database, [a.name, b.name], 'pool'),
        );
        expect(r.cut).toBeGreaterThan(0);
        expect(r.evaluationErrors).toBe(0);
        expect(r.staleClients).toBe(0);
        expect(r.propagatedMs).toBeLessThan(5000);
      }
    },
    timeout,
  );

  it(
    'catches up on changes committed while the LISTEN sessions were down',
    async () => {
      for (const n of rounds) {
        const r = await round('listen-sessions', n, () =>
          terminate(inject('postgresUrl'), database, [a.name, b.name], 'listen'),
        );
        expect(r.cut).toBe(2);
        expect(r.evaluationErrors).toBe(0);
        // Streams stay open; the change waits for the listener to reconnect (after 1 s).
        expect(r.staleClients).toBe(0);
        expect(r.propagatedMs).toBeGreaterThan(900);
        expect(r.propagatedMs).toBeLessThan(5000);
      }
    },
    timeout,
  );

  it(
    'moves SDKs off a SIGKILLed instance and delivers changes made while they moved',
    async () => {
      for (const n of rounds) {
        // Streams pile onto the survivor, so alternate which instance dies.
        const victim = n % 2 === 1 ? a : b;
        const r = await round('instance', n, async () => {
          const cut = balancer.connections(victim.name);
          await victim.kill();
          return cut;
        });
        expect(r.cut).toBeGreaterThan(0);
        expect(r.evaluationErrors).toBe(0);
        expect(r.staleClients).toBeGreaterThan(0);
        expect(r.propagatedMs).toBeLessThan(10_000);
        await victim.start();
      }
    },
    timeout,
  );

  it('leaves every SDK on the server ruleset, without a checksum resync', async () => {
    const res = await fetch(`${balancer.url}/sdk/v1/ruleset`, {
      headers: { authorization: `Bearer ${sdkKey}` },
    });
    const snapshot = (await res.json()) as { version: number; checksum: string };
    await until('every SDK on the latest version', () =>
      fleet.clients.every((c) => c.version === snapshot.version),
    );
    for (const c of fleet.clients) {
      expect(c.checksum).toBe(snapshot.checksum);
      expect(c.resyncs).toBe(0);
    }
    expect(fleet.errors).toBe(0);
    expect(fleet.evaluations).toBeGreaterThan(0);
  });
});

function summary(rs: Recovery[]): string {
  const lines = ['', 'Fault recovery (ms from the fault):', ''];
  lines.push('fault                 round   cut  write  failed  propagated  stale  ready');
  for (const r of rs) {
    lines.push(
      [
        r.fault.padEnd(20),
        String(r.round).padStart(7),
        String(r.cut).padStart(5),
        String(Math.round(r.writeMs)).padStart(6),
        String(r.failedWrites).padStart(7),
        String(Math.round(r.propagatedMs)).padStart(11),
        String(r.staleClients).padStart(6),
        String(Math.round(r.readyMs)).padStart(6),
      ].join(' '),
    );
  }
  return `${lines.join('\n')}\n\n`;
}
