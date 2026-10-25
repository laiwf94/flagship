import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { ADMIN, seed } from './seed';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const address = s.address();
      s.close(() => {
        resolve(typeof address === 'object' && address !== null ? address.port : 0);
      });
    });
  });
}

async function waitReady(url: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`server at ${url} never became ready`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const pg = await new PostgreSqlContainer('postgres:17-alpine').start();
  const port = await freePort();
  const server = spawn(process.execPath, ['apps/server/dist/main.js'], {
    env: {
      ...process.env,
      FLAGSHIP_DATABASE_URL: pg.getConnectionUri(),
      FLAGSHIP_HOST: '127.0.0.1',
      FLAGSHIP_PORT: String(port),
      FLAGSHIP_ADMIN_EMAIL: ADMIN.email,
      FLAGSHIP_ADMIN_PASSWORD: ADMIN.password,
      FLAGSHIP_ADMIN_UI_DIR: 'apps/admin/dist',
      FLAGSHIP_LOG_LEVEL: 'warn',
      FLAGSHIP_EVENTS_FLUSH_MS: '200',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const base = `http://127.0.0.1:${port}`;
  const exited = once(server, 'exit').then(([code]) => {
    throw new Error(`server exited with code ${String(code)} before it was ready`);
  });
  await Promise.race([waitReady(`${base}/readyz`), exited]);
  exited.catch(() => undefined);
  await seed(base);
  process.env.E2E_BASE_URL = base;
  return async () => {
    server.kill('SIGTERM');
    await once(server, 'exit');
    await pg.stop();
  };
}
