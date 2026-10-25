// SSE fan-out: N streams on one server, one change, how long until each
// stream has it. Starts Postgres (Testcontainers) and the built server.
// Usage: pnpm bench:fanout [N ...]   (defaults to 1000 10000)
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { Worker } from 'node:worker_threads';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

const sizes = process.argv
  .slice(2)
  .map(Number)
  .filter((n) => n > 0);
const N = sizes.length > 0 ? sizes : [1000, 10_000];
const ROUNDS = 20;
const WORKERS = 4;
const ADMIN = { email: 'bench@example.com', password: 'benchmark password 1' };

const port = await new Promise((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});
const pg = await new PostgreSqlContainer('postgres:17-alpine').start();
const server = spawn(process.execPath, ['apps/server/dist/main.js'], {
  env: {
    ...process.env,
    FLAGSHIP_DATABASE_URL: pg.getConnectionUri(),
    FLAGSHIP_HOST: '127.0.0.1',
    FLAGSHIP_PORT: String(port),
    FLAGSHIP_ADMIN_EMAIL: ADMIN.email,
    FLAGSHIP_ADMIN_PASSWORD: ADMIN.password,
    FLAGSHIP_MAX_STREAMS: '50000',
    FLAGSHIP_MAX_STREAMS_PER_KEY: '50000',
    FLAGSHIP_LOG_LEVEL: 'warn',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});
const base = `http://127.0.0.1:${port}`;
for (let i = 0; ; i++) {
  try {
    if ((await fetch(`${base}/readyz`)).ok) break;
  } catch {}
  if (i > 150) throw new Error('server did not start');
  await new Promise((r) => setTimeout(r, 200));
}

const signIn = await fetch(`${base}/api/session`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(ADMIN),
});
const cookie = signIn.headers.get('set-cookie').split(';')[0];
const { csrfToken } = await signIn.json();
const api = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { cookie, 'x-csrf-token': csrfToken, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
};
const P = '/api/projects/default';
for (let i = 0; i < 50; i++)
  await api('POST', `${P}/flags`, { key: `flag-${i}`, name: `Flag ${i}`, type: 'boolean' });
const { secret } = await api('POST', `${P}/environments/production/api-keys`, {
  kind: 'server',
  name: 'bench',
});

// Each worker holds a share of the streams and reports when each patch arrives,
// timestamped with performance.timeOrigin + now(), which every thread shares.
const workerSource = `
const http = require('node:http');
const { parentPort, workerData } = require('node:worker_threads');
const agent = new http.Agent({ keepAlive: true, maxSockets: Infinity });
let ready = 0;
// macOS caps the listen backlog at 128, so connect in small batches and retry resets.
const open = async () => {
  for (let attempt = 0; ; attempt++) {
    try { return await openOnce(); } catch (e) { if (attempt > 20) throw e; await new Promise((r) => setTimeout(r, 50 * (attempt + 1))); }
  }
};
const openOnce = () => new Promise((resolve, reject) => {
  const req = http.get(workerData.url, { agent, headers: { authorization: 'Bearer ' + workerData.key } }, (res) => {
    if (res.statusCode !== 200) { reject(new Error('status ' + res.statusCode)); return; }
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      const at = performance.timeOrigin + performance.now();
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\\n\\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (block.includes('event: put')) { ready++; if (ready === workerData.count) parentPort.postMessage({ ready: true }); }
        else if (block.includes('event: patch')) {
          const id = Number(/id: (\\d+)/.exec(block)[1]);
          parentPort.postMessage({ id, at });
        }
      }
    });
    resolve();
  });
  req.on('error', reject);
});
(async () => {
  for (let i = 0; i < workerData.count; i += 25) {
    await Promise.all(Array.from({ length: Math.min(25, workerData.count - i) }, open));
  }
})().catch((e) => parentPort.postMessage({ error: String(e) }));
`;

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

const results = [];
for (const n of N) {
  const per = Math.ceil(n / WORKERS);
  const arrivals = new Map();
  let readyWorkers = 0;
  const workers = Array.from({ length: WORKERS }, (_, w) => {
    const count = Math.min(per, n - w * per);
    const worker = new Worker(workerSource, {
      eval: true,
      workerData: { url: `${base}/sdk/v1/stream`, key: secret, count },
    });
    worker.on('message', (m) => {
      if (m.error) throw new Error(m.error);
      if (m.ready) readyWorkers++;
      else {
        const list = arrivals.get(m.id) ?? [];
        list.push(m.at);
        arrivals.set(m.id, list);
      }
    });
    return worker;
  });
  while (readyWorkers < WORKERS) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 1000));

  const latencies = [];
  for (let round = 0; round < ROUNDS; round++) {
    const sent = performance.timeOrigin + performance.now();
    const flag = await api(
      'POST',
      `${P}/flags/flag-${round % 50}/environments/production/kill-switch`,
      { enabled: round % 2 === 0 },
    );
    const ruleset = await (
      await fetch(`${base}/sdk/v1/ruleset`, { headers: { authorization: `Bearer ${secret}` } })
    ).json();
    const id = ruleset.version;
    const deadline = Date.now() + 30_000;
    while ((arrivals.get(id)?.length ?? 0) < n) {
      if (Date.now() > deadline)
        throw new Error(`only ${arrivals.get(id)?.length ?? 0}/${n} got version ${id}`);
      await new Promise((r) => setTimeout(r, 5));
    }
    for (const at of arrivals.get(id)) latencies.push(at - sent);
    void flag;
    await new Promise((r) => setTimeout(r, 300));
  }
  latencies.sort((a, b) => a - b);
  results.push({
    n,
    p50: percentile(latencies, 50),
    p99: percentile(latencies, 99),
    max: latencies[latencies.length - 1],
  });
  await Promise.all(workers.map((w) => w.terminate()));
  await new Promise((r) => setTimeout(r, 1500));
}

console.log(
  `\n${ROUNDS} changes per run; latency from the API call that makes the change to the patch arriving at each stream.\n`,
);
console.log('| Connected streams | p50 | p99 | max |');
console.log('|---|---|---|---|');
for (const r of results)
  console.log(
    `| ${r.n.toLocaleString('en-US')} | ${r.p50.toFixed(1)} ms | ${r.p99.toFixed(1)} ms | ${r.max.toFixed(1)} ms |`,
  );

server.kill('SIGTERM');
await once(server, 'exit');
await pg.stop();
process.exit(0);
