import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApp, type TestApp } from '../../test/app.js';
import { PASSWORD, signIn, type Client } from '../../test/session.js';
import type { Sink } from './hub.js';

let t: TestApp;
let admin: Client;
let envId: string;

const P = '/api/projects/default';

class MemorySink implements Sink {
  chunks: string[] = [];
  ended = false;
  writableLength = 0;
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  end(): void {
    this.ended = true;
  }
  events(name: string): string[] {
    return this.chunks.filter((c) => c.includes(`event: ${name}\n`));
  }
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function kill(key: string, enabled: boolean): Promise<void> {
  const res = await admin.request('POST', `${P}/flags/${key}/environments/production/kill-switch`, {
    enabled,
  });
  expect(res.statusCode).toBe(200);
}

beforeAll(async () => {
  t = await testApp({
    bootstrapAdmin: { email: 'root@example.com', password: PASSWORD },
    changeRetention: 10,
    heartbeatSeconds: 60,
  });
  admin = await signIn(t.app.server, 'root@example.com');
  await admin.request('POST', `${P}/flags`, { key: 'f', name: 'f', type: 'boolean' });
  const env = await t.db
    .selectFrom('environments')
    .select('id')
    .where('key', '=', 'production')
    .executeTakeFirstOrThrow();
  envId = env.id;
});
afterAll(() => t.close());

const identity = (keyId = 'k1') => ({ kind: 'server' as const, keyId, environmentId: envId });

describe('Hub', () => {
  it('drops a subscriber that stops reading', async () => {
    const sink = new MemorySink();
    await t.app.hub.subscribe(identity(), sink, undefined);
    expect(sink.events('put')).toHaveLength(1);
    sink.writableLength = 2 * 1024 * 1024;
    await kill('f', true);
    await until(() => sink.ended);
    expect(t.app.metrics.streamDrops.get({ reason: 'slow' })).toBe(1);
  });

  it('reports open connections by kind in the metrics', async () => {
    const sink = new MemorySink();
    const stop = await t.app.hub.subscribe(identity('k2'), sink, undefined);
    const client = new MemorySink();
    const stopClient = await t.app.hub.subscribe(
      { kind: 'client', keyId: 'k3', environmentId: envId },
      client,
      undefined,
    );
    const text = t.app.metrics.registry.render();
    expect(text).toContain('flagship_sse_connections{kind="server"} 1');
    expect(text).toContain('flagship_sse_connections{kind="client"} 1');
    expect(client.events('version')).toHaveLength(1);
    stop();
    stopClient();
    stop();
    expect(t.app.hub.connections).toBe(0);
  });

  it('recovers from a lost listener connection and resends a put when history was pruned meanwhile', async () => {
    const sink = new MemorySink();
    const stop = await t.app.hub.subscribe(identity('k4'), sink, undefined);
    await sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
              WHERE query LIKE 'LISTEN%' AND datname = current_database()
                AND pid <> pg_backend_pid()`.execute(t.db);
    for (let i = 0; i < 12; i++) await kill('f', i % 2 === 1);
    // The listener reconnects after about a second; under load it can come back
    // while the changes above are still being made, so the put may be followed
    // by patches. Either way the stream must end on the latest state.
    await until(() => sink.events('put').length >= 2, 8000);
    const last = () => sink.chunks.filter((c) => c.includes('event: ')).at(-1) ?? '';
    await until(() => last().includes('"enabled":true'), 8000);
    await kill('f', false);
    await until(() => sink.events('patch').some((c) => c.includes('"enabled":false')));
    stop();
  });

  it('catches up from the oldest subscriber when it has no broadcast record', async () => {
    const sinks = Array.from({ length: 3 }, () => new MemorySink());
    const stops = await Promise.all(
      sinks.map((s, i) => t.app.hub.subscribe(identity(`m${i}`), s, undefined)),
    );
    (t.app.hub as unknown as { broadcastVersion: Map<string, number> }).broadcastVersion.clear();
    await kill('f', true);
    await until(() => sinks.every((s) => s.events('patch').length === 1));
    for (const stop of stops) stop();
  });

  it('refuses new subscribers past the total limit', async () => {
    const small = await testApp({ maxStreams: 1 });
    try {
      const env = await small.db
        .insertInto('projects')
        .values({ key: 'p', name: 'p' })
        .returning('id')
        .executeTakeFirstOrThrow();
      const e = await small.db
        .insertInto('environments')
        .values({ project_id: env.id, key: 'e', name: 'e' })
        .returning('id')
        .executeTakeFirstOrThrow();
      const id = { kind: 'client' as const, keyId: 'c', environmentId: e.id };
      await small.app.hub.subscribe(id, new MemorySink(), undefined);
      expect(small.app.hub.canAccept(id)).toBe('this server has reached its stream limit');
      await expect(small.app.hub.subscribe(id, new MemorySink(), undefined)).rejects.toThrow(
        'stream limit',
      );
      await expect(
        small.app.hub.subscribe(
          { ...id, environmentId: '00000000-0000-4000-8000-000000000000' },
          new MemorySink(),
          undefined,
        ),
      ).rejects.toThrow();
    } finally {
      await small.close();
    }
  });
});
