// Fault recovery: runs the fault-injection suite in apps/server/test/faults
// (two server processes, 40 SDK clients, Postgres in Testcontainers) and
// writes the per-round and per-fault recovery times as JSON.
// Usage: pnpm bench:faults [--rounds N] [--out FILE]
//   defaults: 10 rounds per fault, bench/results/faults.json
import { spawn } from 'node:child_process';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    rounds: { type: 'string', default: '10' },
    out: { type: 'string', default: 'bench/results/faults.json' },
  },
});
const rounds = Number(values.rounds);
if (!Number.isInteger(rounds) || rounds < 1) {
  process.stderr.write(`--rounds must be a positive integer, not ${values.rounds}\n`);
  process.exit(2);
}
const out = path.resolve(values.out);

const child = spawn(
  'pnpm',
  ['exec', 'vitest', 'run', '--project', 'server', 'apps/server/test/faults/recovery.test.ts'],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      FLAGSHIP_FAULT_ROUNDS: String(rounds),
      FLAGSHIP_FAULT_RESULTS: out,
    },
  },
);
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
