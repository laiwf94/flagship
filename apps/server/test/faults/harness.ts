import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { FlagshipClient } from '@flagship/node';
import pg from 'pg';

const SERVER_DIR = fileURLToPath(new URL('../..', import.meta.url));
const HOOKS = fileURLToPath(new URL('./hooks.mjs', import.meta.url));

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function freePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as net.AddressInfo;
  server.close();
  await once(server, 'close');
  return port;
}

/** Polls `check` every 5 ms until it holds, or throws after `ms`. */
export async function until(what: string, check: () => boolean, ms = 15_000): Promise<void> {
  const start = performance.now();
  while (!check()) {
    if (performance.now() - start > ms) throw new Error(`${what}: not within ${ms} ms`);
    await sleep(5);
  }
}

/**
 * One flagship server in its own process, run from source, so it can be
 * killed with SIGKILL: no shutdown hook runs, its sockets are closed by the
 * kernel and Postgres sees its sessions vanish.
 */
export class Instance {
  private proc: ChildProcess | null = null;
  private exited: Promise<void> = Promise.resolve();
  readonly output: string[] = [];

  private constructor(
    readonly name: string,
    readonly port: number,
    private readonly env: Record<string, string>,
  ) {}

  /** `name` becomes the Postgres application_name of every session it opens. */
  static async create(name: string, databaseUrl: string, env: Record<string, string>) {
    const url = new URL(databaseUrl);
    url.searchParams.set('application_name', name);
    const port = await freePort();
    return new Instance(name, port, {
      ...env,
      FLAGSHIP_DATABASE_URL: url.toString(),
      FLAGSHIP_HOST: '127.0.0.1',
      FLAGSHIP_PORT: String(port),
    });
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get running(): boolean {
    return this.proc !== null;
  }

  async start(timeoutMs = 30_000): Promise<void> {
    if (this.proc !== null) throw new Error(`${this.name} is already running`);
    const proc = spawn(
      process.execPath,
      [
        '--experimental-transform-types',
        '--disable-warning=ExperimentalWarning',
        '--conditions=@flagship/source',
        '--import',
        HOOKS,
        'src/main.ts',
      ],
      {
        cwd: SERVER_DIR,
        env: { PATH: process.env.PATH ?? '', ...this.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    this.proc = proc;
    const keep = (chunk: Buffer) => {
      this.output.push(chunk.toString('utf8'));
      if (this.output.length > 200) this.output.shift();
    };
    proc.stdout.on('data', keep);
    proc.stderr.on('data', keep);
    this.exited = new Promise((resolve) => {
      proc.once('exit', () => {
        if (this.proc === proc) this.proc = null;
        resolve();
      });
    });
    const start = performance.now();
    for (;;) {
      if (this.proc !== proc) {
        throw new Error(`${this.name} exited during start:\n${this.output.join('')}`);
      }
      try {
        const res = await fetch(`${this.url}/readyz`, { signal: AbortSignal.timeout(1000) });
        if (res.status === 200) return;
      } catch {
        // not listening yet
      }
      if (performance.now() - start > timeoutMs) {
        await this.kill();
        throw new Error(`${this.name} not ready within ${timeoutMs} ms:\n${this.output.join('')}`);
      }
      await sleep(50);
    }
  }

  /** SIGKILL, and wait for the process to be gone. */
  async kill(): Promise<void> {
    this.proc?.kill('SIGKILL');
    await this.exited;
  }
}

/**
 * A layer-4 load balancer: each client connection goes to the next backend
 * in turn, skipping backends that refuse the connection, and is cut when its
 * backend's side closes. That is all an SDK needs to fail over.
 */
export class Balancer {
  private server: net.Server | null = null;
  private next = 0;
  private readonly live = new Map<string, Set<net.Socket>>();
  port = 0;

  constructor(private readonly backends: Instance[]) {
    for (const b of backends) this.live.set(b.name, new Set());
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Open client connections per backend. */
  connections(name: string): number {
    return this.live.get(name)?.size ?? 0;
  }

  async start(): Promise<void> {
    const server = net.createServer((client) => {
      client.pause();
      client.on('error', () => undefined);
      this.route(client, this.next++, 0);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    this.port = (server.address() as net.AddressInfo).port;
    this.server = server;
  }

  /** Tries the backends in turn from `first`, so each is tried once per connection. */
  private route(client: net.Socket, first: number, tried: number): void {
    if (client.destroyed) return;
    if (tried >= this.backends.length) {
      client.destroy();
      return;
    }
    const backend = this.backends[(first + tried) % this.backends.length]!;
    const upstream = net.connect(backend.port, '127.0.0.1');
    let connected = false;
    upstream.once('connect', () => {
      connected = true;
      const set = this.live.get(backend.name)!;
      set.add(client);
      const done = () => {
        set.delete(client);
        client.destroy();
        upstream.destroy();
      };
      client.once('close', done);
      upstream.once('close', done);
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
    upstream.on('error', () => {
      if (!connected) this.route(client, first, tried + 1);
    });
  }

  async close(): Promise<void> {
    for (const set of this.live.values()) for (const s of set) s.destroy();
    if (this.server === null) return;
    const closed = once(this.server, 'close');
    this.server.close();
    await closed;
  }
}

/** A signed-in admin over plain HTTP. */
export class Admin {
  private constructor(
    private readonly baseUrl: string,
    private readonly cookie: string,
    private readonly csrf: string,
  ) {}

  static async signIn(baseUrl: string, email: string, password: string): Promise<Admin> {
    const res = await fetch(`${baseUrl}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (res.status !== 200) throw new Error(`sign-in failed: ${res.status} ${await res.text()}`);
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const body = (await res.json()) as { csrfToken: string };
    return new Admin(baseUrl, cookie, body.csrfToken);
  }

  async request(method: string, path: string, body?: unknown, timeoutMs = 5000) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        cookie: this.cookie,
        'x-csrf-token': this.csrf,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    return { status: res.status, body: text, json: () => JSON.parse(text) };
  }
}

export interface Write {
  /** From the fault to the first accepted request. */
  ms: number;
  /** Requests refused or lost before that. */
  failures: number;
}

/**
 * Sends one request every 50 ms until the server accepts it, the way an
 * operator or a script would retry an important change during an incident.
 */
export async function retry(
  since: number,
  send: () => Promise<{ status: number }>,
  ms = 20_000,
): Promise<Write> {
  let failures = 0;
  for (;;) {
    try {
      const res = await send();
      if (res.status >= 200 && res.status < 300) return { ms: performance.now() - since, failures };
    } catch {
      // connection refused, reset or timed out
    }
    failures++;
    if (performance.now() - since > ms) throw new Error(`no request accepted within ${ms} ms`);
    await sleep(50);
  }
}

/**
 * SDK clients evaluating one boolean flag in a loop, as an app serving
 * requests would. Counts every evaluation that did not come from a ruleset
 * (the caller's default), which clients left `ready`, and when each one
 * started serving the value it is expected to change to.
 */
export class Fleet {
  readonly clients: FlagshipClient[];
  evaluations = 0;
  errors = 0;
  /** Clients that left `ready` since `expect` was last called. */
  readonly left = new Set<number>();
  /** When the last of those clients was `ready` again. */
  backAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private target: boolean | undefined;
  private seenAt: (number | undefined)[];

  constructor(
    size: number,
    baseUrl: string,
    sdkKey: string,
    private readonly flag: string,
  ) {
    this.clients = Array.from(
      { length: size },
      () => new FlagshipClient({ sdkKey, baseUrl, exposureFlushMs: 250 }),
    );
    this.seenAt = this.clients.map(() => undefined);
    this.clients.forEach((c, i) => {
      c.on('status', (s) => {
        if (s !== 'ready') this.left.add(i);
        else if (this.left.has(i)) this.backAt = performance.now();
      });
      c.on('change', () => {
        if (this.seenAt[i] === undefined && this.value(c) === this.target) {
          this.seenAt[i] = performance.now();
        }
      });
    });
  }

  async ready(): Promise<void> {
    const ok = await Promise.all(this.clients.map((c) => c.ready(15_000)));
    if (ok.includes(false)) throw new Error('not every SDK client got a ruleset');
  }

  start(): void {
    let n = 0;
    this.timer = setInterval(() => {
      for (const c of this.clients) {
        for (let i = 0; i < 20; i++) {
          const d = c.boolDetail(this.flag, { key: `user-${n++ % 1000}` }, false);
          this.evaluations++;
          if (d.reason === 'ERROR') this.errors++;
        }
      }
    }, 2);
  }

  private value(c: FlagshipClient): boolean {
    return c.boolVariation(this.flag, { key: 'probe' }, false);
  }

  allReady(): boolean {
    return this.clients.every((c) => c.status === 'ready');
  }

  /** Starts watching for every client to change to `value`. */
  expect(value: boolean): void {
    this.target = value;
    this.left.clear();
    this.backAt = 0;
    this.seenAt = this.clients.map((c) => (this.value(c) === value ? 0 : undefined));
  }

  /** Milliseconds from `since` until the last client served the expected value. */
  async converged(since: number, ms = 20_000): Promise<number> {
    await until('every SDK serving the new value', () => !this.seenAt.includes(undefined), ms);
    const at = this.seenAt as number[];
    if (at.includes(0)) throw new Error('a client served the new value before the change');
    return Math.max(...at) - since;
  }

  async close(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    await Promise.all(this.clients.map((c) => c.close()));
  }
}

/**
 * Terminates the Postgres sessions of the given instances that match
 * `which`, the way a failover, a pooler restart or an idle-connection reaper
 * would. Returns how many were terminated.
 */
export async function terminate(
  adminUrl: string,
  database: string,
  instances: string[],
  which: 'pool' | 'listen',
): Promise<number> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const listen = which === 'listen' ? '' : 'NOT';
    const { rows } = await client.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
        WHERE datname = $1 AND application_name = ANY($2)
          AND ${listen} (query LIKE 'LISTEN %')`,
      [database, instances],
    );
    for (const { pid } of rows) await client.query('SELECT pg_terminate_backend($1)', [pid]);
    return rows.length;
  } finally {
    await client.end();
  }
}
