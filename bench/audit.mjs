// Audit search: seeds one project with N audit entries (1,000,000 by default)
// in Postgres (Testcontainers, stock settings) and times searchAudit, the
// function behind GET /api/projects/:project/audit, for each kind of filter:
// newest page, deep keyset page, flag, segment, actor, text (rare, common,
// none), date ranges and combinations. Every query asks for a 50-entry page
// and includes building the diffs, as the route does.
// Usage: pnpm bench:audit [--entries N] [--runs N] [--budget MS] [--out FILE]
//   defaults: 1,000,000 entries, 200 runs per query, 50 ms p95 budget,
//   bench/results/audit.json. Exits 1 when any query's p95 is over budget.
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createDatabase, migrate } from '../apps/server/dist/db/database.js';
import { decodeCursor, encodeCursor, searchAudit } from '../apps/server/dist/services/audit.js';

// kysely is the server's dependency, not the workspace root's.
const fromServer = createRequire(new URL('../apps/server/package.json', import.meta.url));
const { sql } = await import(pathToFileURL(fromServer.resolve('kysely')).href);

const { values } = parseArgs({
  options: {
    entries: { type: 'string', default: '1000000' },
    runs: { type: 'string', default: '200' },
    budget: { type: 'string', default: '50' },
    out: { type: 'string', default: 'bench/results/audit.json' },
  },
});
const entries = Number(values.entries);
const runs = Number(values.runs);
const budget = Number(values.budget);
for (const [name, v] of [
  ['entries', entries],
  ['runs', runs],
  ['budget', budget],
]) {
  if (!Number.isInteger(v) || v < 1) {
    process.stderr.write(`--${name} must be a positive integer\n`);
    process.exit(2);
  }
}

const FLAGS = 2000;
const SEGMENTS = 200;
const ACTORS = 50;
const DAYS = 400;
const LIMIT = 50;
const END = new Date('2026-11-01T00:00:00Z');
const log = (line) => process.stdout.write(`${line}\n`);

log('starting postgres:17-alpine');
const container = await new PostgreSqlContainer('postgres:17-alpine').start();
const { db } = createDatabase({ url: container.getConnectionUri(), maxConnections: 4 });
let failed = false;
try {
  await migrate(db);
  const project = await db
    .insertInto('projects')
    .values({ key: 'bench', name: 'Bench' })
    .returning('id')
    .executeTakeFirstOrThrow();
  await sql`INSERT INTO environments (project_id, key, name)
    SELECT ${project.id}::uuid, e, e FROM unnest(ARRAY['development', 'staging', 'production']) AS e`.execute(
    db,
  );

  // Entries spread evenly over DAYS days up to END, oldest first, so ids
  // and times rise together as they do in a live log. One in three has a
  // reason drawn from a small vocabulary plus a unique ticket number, one in
  // ten a link. Actors are skewed: the first few make most changes.
  const seedStart = performance.now();
  const BATCH = 100_000;
  for (let from = 1; from <= entries; from += BATCH) {
    const to = Math.min(entries, from + BATCH - 1);
    await sql`INSERT INTO audit_log (project_id, environment_id, actor_name, action, target_type,
        target_key, reason, link, before, after, created_at)
      SELECT ${project.id}::uuid,
        (ARRAY(SELECT id FROM environments WHERE project_id = ${project.id}::uuid
          ORDER BY key))[1 + i % 3],
        'user-' || (floor(${ACTORS} * power(random(), 3)))::int,
        (ARRAY['flag.config.update', 'flag.config.update', 'flag.kill_switch', 'flag.update',
          'segment.update', 'flag.change_request.apply'])[1 + i % 6],
        CASE WHEN i % 6 = 4 THEN 'segment' ELSE 'flag' END,
        CASE WHEN i % 6 = 4 THEN 'segment-' || (i::bigint * 7919 % ${SEGMENTS})
          ELSE 'flag-' || (i::bigint * 104729 % ${FLAGS}) END,
        CASE WHEN i % 3 = 0 THEN
          (ARRAY['Rollout to more users', 'Rollback after errors', 'Enable for beta group',
            'Clean up old rule', 'Experiment launch', 'Incident mitigation'])[1 + (i / 3) % 6]
          || ' TCK-' || i END,
        CASE WHEN i % 10 = 0 THEN 'https://tickets.example.com/TCK-' || i END,
        jsonb_build_object('enabled', i % 2 = 0, 'fallthrough', jsonb_build_object('variant', 'off')),
        jsonb_build_object('enabled', i % 2 = 1, 'fallthrough', jsonb_build_object('variant', 'on')),
        ${END.toISOString()}::timestamptz
          - make_interval(secs => (${entries} - i)::float8 * ${(DAYS * 86400) / entries})
      FROM generate_series(${from}::int, ${to}::int) AS i`.execute(db);
    log(`seeded ${to.toLocaleString('en-US')} entries`);
  }
  await sql`VACUUM ANALYZE audit_log`.execute(db);
  const seedSeconds = (performance.now() - seedStart) / 1000;
  const size = await sql`SELECT pg_size_pretty(pg_total_relation_size('audit_log')) AS total,
      pg_size_pretty(pg_relation_size('audit_log_search_idx')) AS search`.execute(db);
  log(
    `seeded in ${seedSeconds.toFixed(1)} s; table ${size.rows[0].total}, search index ${size.rows[0].search}`,
  );

  const middle = await sql`SELECT to_char(created_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at, id FROM audit_log
    WHERE id = ${Math.floor(entries / 2)}`.execute(db);
  const deep = encodeCursor({ at: middle.rows[0].at, id: middle.rows[0].id });

  let seed = 1;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const day = (n) => new Date(END.getTime() - n * 86_400_000);

  const queries = [
    ['newest page', () => ({})],
    ['deep page (keyset at 50%)', () => ({ after: decodeCursor(deep) })],
    ['flag', () => ({ targetType: 'flag', targetKey: `flag-${rand(FLAGS)}` })],
    ['segment', () => ({ targetType: 'segment', targetKey: `segment-${rand(SEGMENTS)}` })],
    ['actor (frequent)', () => ({ actor: `user-${rand(3)}` })],
    ['actor (rare)', () => ({ actor: `user-${45 + rand(5)}` })],
    [
      'text, rare (ticket number)',
      () => ({ text: `TCK-${3 * (1 + rand(Math.floor(entries / 3) - 1))}` }),
    ],
    ['text, common word', () => ({ text: 'rollback' })],
    ['text, two words', () => ({ text: 'experiment launch' })],
    ['text, phrase', () => ({ text: '"incident mitigation"' })],
    ['text, no match', () => ({ text: 'nonexistent' })],
    [
      'dates, one day',
      () => {
        const d = 1 + rand(DAYS - 2);
        return { from: day(d + 1), to: day(d) };
      },
    ],
    ['dates, 30 days a year ago', () => ({ from: day(395), to: day(365) })],
    [
      'flag + 90 days',
      () => ({
        targetType: 'flag',
        targetKey: `flag-${rand(FLAGS)}`,
        from: day(90),
        to: END,
      }),
    ],
    ['actor + text', () => ({ actor: `user-${rand(10)}`, text: 'rollback' })],
    [
      'text + one week',
      () => {
        const d = 7 + rand(DAYS - 8);
        return { text: 'experiment', from: day(d), to: day(d - 7) };
      },
    ],
  ];

  const results = [];
  for (const [name, make] of queries) {
    for (let i = 0; i < 10; i++) await searchAudit(db, project.id, { ...make(), limit: LIMIT });
    const times = [];
    let rows = 0;
    for (let i = 0; i < runs; i++) {
      const filter = { ...make(), limit: LIMIT };
      const start = performance.now();
      const page = await searchAudit(db, project.id, filter);
      times.push(performance.now() - start);
      rows += page.entries.length;
    }
    times.sort((a, b) => a - b);
    const at = (q) => times[Math.min(times.length - 1, Math.floor(q * times.length))];
    const r = {
      query: name,
      p50: round(at(0.5)),
      p95: round(at(0.95)),
      p99: round(at(0.99)),
      max: round(times.at(-1)),
      meanRows: round(rows / runs),
    };
    results.push(r);
    if (r.p95 >= budget) failed = true;
    log(
      `${name.padEnd(28)} p50 ${fmt(r.p50)}  p95 ${fmt(r.p95)}  p99 ${fmt(r.p99)}  max ${fmt(r.max)}  rows ${r.meanRows}${r.p95 >= budget ? '  OVER BUDGET' : ''}`,
    );
  }

  const out = path.resolve(values.out);
  writeFileSync(
    out,
    `${JSON.stringify(
      {
        benchmark: 'audit search',
        entries,
        runsPerQuery: runs,
        pageSize: LIMIT,
        budgetMs: budget,
        postgres: 'postgres:17-alpine, default settings',
        node: process.version,
        seedSeconds: round(seedSeconds),
        tableSize: size.rows[0].total,
        searchIndexSize: size.rows[0].search,
        unit: 'ms',
        results,
      },
      null,
      2,
    )}\n`,
  );
  log(`wrote ${path.relative(process.cwd(), out)}`);
} finally {
  await db.destroy();
  await container.stop();
}
if (failed) {
  process.stderr.write(`some queries were over the ${budget} ms p95 budget\n`);
  process.exit(1);
}

function round(n) {
  return Math.round(n * 100) / 100;
}

function fmt(ms) {
  return `${ms.toFixed(2).padStart(7)} ms`;
}
