import type { AddressInfo } from 'node:net';
import {
  RulesetDigest,
  evaluationChecksum,
  rulesetChecksum,
  type Flag,
  type Ruleset,
  type Segment,
} from '@flagship/core';
import { ChecksumError, FlagshipClient } from '@flagship/node';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApp, type TestApp } from '../test/app.js';
import { PASSWORD, signIn, type Client } from '../test/session.js';
import { openStream, type SseClient, type SseEvent } from '../test/sse.js';

let t: TestApp;
let admin: Client;
let base: string;
let serverKey: string;
let clientKey: string;

const P = '/api/projects/default';
const E = 'production';

interface Patch {
  kind: 'flag' | 'segment';
  key: string;
  value: Flag | Segment | null;
  checksum?: string;
}

async function ok(
  method: Parameters<Client['request']>[0],
  url: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const res = await admin.request(method, url, body);
  expect(res.statusCode, `${method} ${url}: ${res.body}`).toBeLessThan(300);
  return res.body === '' ? {} : res.json<Record<string, unknown>>();
}

async function flagVersions(key: string): Promise<{ metadata: number; targeting: number }> {
  const f = (await admin.request('GET', `${P}/flags/${key}`)).json();
  return { metadata: f.version, targeting: f.environments[E].version };
}

async function snapshot(): Promise<Ruleset> {
  const res = await fetch(`${base}/sdk/v1/ruleset`, {
    headers: { authorization: `Bearer ${serverKey}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Ruleset;
}

const stream = (headers: Record<string, string> = {}) =>
  openStream(`${base}/sdk/v1/stream`, { authorization: `Bearer ${serverKey}`, ...headers });

/** Applies patches the way an SDK does and checks each against the checksum it carries. */
class Follower {
  readonly digest: RulesetDigest;
  version: number;
  constructor(put: SseEvent) {
    const ruleset = JSON.parse(put.data) as Ruleset;
    expect(ruleset.checksum).toBe(rulesetChecksum(ruleset));
    this.digest = RulesetDigest.of(ruleset);
    this.version = ruleset.version;
  }
  apply(e: SseEvent): void {
    expect(e.event).toBe('patch');
    expect(Number(e.id)).toBe(this.version + 1);
    const p = JSON.parse(e.data) as Patch;
    const next = this.digest.prepare(p.kind, p.key, p.value);
    expect(p.checksum, `patch ${e.id} (${p.kind} ${p.key})`).toBe(next.checksum);
    next.apply();
    this.version++;
  }
  async follow(s: SseClient, upTo: number): Promise<void> {
    while (this.version < upTo) this.apply(await s.next((e) => e.event === 'patch'));
  }
}

beforeAll(async () => {
  t = await testApp({
    bootstrapAdmin: { email: 'root@example.com', password: PASSWORD },
    changeRetention: 1000,
  });
  admin = await signIn(t.app.server, 'root@example.com');
  await t.app.server.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(t.app.server.server.address() as AddressInfo).port}`;
  const keys = `${P}/environments/${E}/api-keys`;
  serverKey = (await ok('POST', keys, { kind: 'server', name: 'svc' })).secret as string;
  clientKey = (await ok('POST', keys, { kind: 'client', name: 'web' })).secret as string;
});
afterAll(() => t.close());

describe('ruleset checksums', () => {
  it('come with the snapshot and every kind of patch, and always add up', async () => {
    const s = await stream();
    const follower = new Follower(await s.next((e) => e.event === 'put'));
    const start = follower.version;
    try {
      await ok('POST', `${P}/flags`, { key: 'sum-a', name: 'A', type: 'boolean' });
      await ok('POST', `${P}/flags`, {
        key: 'sum-json',
        name: 'Config',
        type: 'json',
        variants: [
          { key: 'small', value: { z: 1, a: [1.5, 'é'], '😀': null } },
          { key: 'large', value: { limits: { big: 1e21, tiny: 5e-7 } } },
        ],
      });
      await ok('POST', `${P}/environments/${E}/segments`, {
        key: 'sum-testers',
        name: 'Testers',
        included: ['alice'],
        excluded: [],
        rules: [],
      });
      let v = await flagVersions('sum-a');
      await ok('PUT', `${P}/flags/sum-a/environments/${E}`, {
        version: v.targeting,
        enabled: true,
        offVariant: 'off',
        prerequisites: [],
        rules: [
          {
            id: 'testers',
            clauses: [{ operator: 'inSegment', segments: ['sum-testers'] }],
            serve: { variant: 'on' },
          },
        ],
        fallthrough: { variant: 'off' },
      });
      await ok('POST', `${P}/flags/sum-a/environments/${E}/kill-switch`, { enabled: false });
      v = await flagVersions('sum-a');
      await ok('PUT', `${P}/flags/sum-a`, { version: v.metadata, clientSide: true });
      await ok('PUT', `${P}/environments/${E}/segments/sum-testers`, {
        version: 1,
        name: 'Testers',
        included: ['alice', 'bob'],
        excluded: [],
        rules: [],
      });
      v = await flagVersions('sum-json');
      await ok('POST', `${P}/flags/sum-json/archive`, { version: v.metadata });
      await ok('POST', `${P}/flags/sum-json/restore`, { version: v.metadata + 1 });
      await ok('POST', `${P}/environments/${E}/segments`, {
        key: 'sum-unused',
        name: 'Unused',
        included: [],
        excluded: [],
        rules: [],
      });
      await ok('DELETE', `${P}/environments/${E}/segments/sum-unused?version=1`);

      const final = await snapshot();
      expect(final.version).toBe(start + 11);
      await follower.follow(s, final.version);
      expect(follower.digest.checksum).toBe(final.checksum);
      expect(final.checksum).toBe(rulesetChecksum(final));
    } finally {
      s.close();
    }
  });

  it('stay consistent when many writers change one environment at once', async () => {
    const keys = Array.from({ length: 6 }, (_, i) => `busy-${i}`);
    for (const key of keys) await ok('POST', `${P}/flags`, { key, name: key, type: 'boolean' });
    const s = await stream();
    const follower = new Follower(await s.next((e) => e.event === 'put'));
    try {
      await Promise.all(
        keys.flatMap((key) => [
          ok('POST', `${P}/flags/${key}/environments/${E}/kill-switch`, { enabled: false }),
          ok('POST', `${P}/flags/${key}/environments/${E}/kill-switch`, { enabled: true }),
        ]),
      );
      const final = await snapshot();
      expect(final.version).toBe(follower.version + keys.length * 2);
      await follower.follow(s, final.version);
      expect(follower.digest.checksum).toBe(final.checksum);
    } finally {
      s.close();
    }
  });

  it('are resent on resume and left out for changes recorded before checksums', async () => {
    const before = await snapshot();
    await ok('POST', `${P}/flags/sum-a/environments/${E}/kill-switch`, { enabled: true });
    await ok('POST', `${P}/flags/sum-a/environments/${E}/kill-switch`, { enabled: false });
    await sql`UPDATE ruleset_changes SET checksum = NULL
      WHERE version = ${before.version + 1}`.execute(t.db);
    const s = await stream({ 'last-event-id': String(before.version) });
    try {
      const first = JSON.parse((await s.next()).data) as Patch;
      const second = JSON.parse((await s.next()).data) as Patch;
      expect(first).not.toHaveProperty('checksum');
      expect(second.checksum).toBe((await snapshot()).checksum);
    } finally {
      s.close();
    }
  });

  it('cover the evaluation answer browsers get', async () => {
    const res = await fetch(`${base}/sdk/v1/evaluate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${clientKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ context: { key: 'alice' } }),
    });
    const body = (await res.json()) as { flags: Record<string, unknown>; checksum: string };
    expect(Object.keys(body.flags)).toContain('sum-a');
    expect(body.checksum).toBe(evaluationChecksum(body.flags));
  });

  it('make the Node SDK resync when a recorded patch is corrupted', async () => {
    const sdk = new FlagshipClient({
      sdkKey: serverKey,
      baseUrl: base,
      sendExposures: false,
      reconnectMs: { initial: 20, max: 100 },
    });
    const errors: Error[] = [];
    sdk.on('error', (e) => errors.push(e));
    try {
      expect(await sdk.ready()).toBe(true);
      expect(sdk.checksum).toBe((await snapshot()).checksum);
      // Corrupt the stored patch in flight: it now says the kill switch is on.
      await sql`CREATE FUNCTION corrupt_change() RETURNS trigger AS $$
        BEGIN
          NEW.value := jsonb_set(NEW.value, '{enabled}', 'true');
          RETURN NEW;
        END $$ LANGUAGE plpgsql`.execute(t.db);
      await sql`CREATE TRIGGER corrupt_change BEFORE INSERT ON ruleset_changes
        FOR EACH ROW EXECUTE FUNCTION corrupt_change()`.execute(t.db);
      try {
        const v = await flagVersions('sum-a');
        await ok('PUT', `${P}/flags/sum-a`, { version: v.metadata, description: 'corrupted' });
      } finally {
        await sql`DROP TRIGGER corrupt_change ON ruleset_changes`.execute(t.db);
        await sql`DROP FUNCTION corrupt_change()`.execute(t.db);
      }
      const truth = await snapshot();
      await expect.poll(() => sdk.resyncs, { timeout: 5000 }).toBe(1);
      await expect.poll(() => sdk.checksum, { timeout: 5000 }).toBe(truth.checksum);
      expect(errors[0]).toBeInstanceOf(ChecksumError);
      expect(sdk.version).toBe(truth.version);
      expect(sdk.boolDetail('sum-a', { key: 'alice' }, true).reason).toBe('DISABLED');
    } finally {
      await sdk.close();
    }
  });
});
