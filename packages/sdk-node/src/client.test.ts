import { rulesetChecksum, type Flag, type Ruleset } from '@flagship/core';
import { afterEach, describe, expect, it } from 'vitest';
import { StubServer, until } from '../test/stub.js';
import {
  ChecksumError,
  FlagshipClient,
  packEvents,
  type ChangeEvent,
  type EventBatch,
  type Status,
} from './client.js';

function flag(key: string, extra: Partial<Flag> = {}): Flag {
  return {
    key,
    type: 'boolean',
    variants: [
      { key: 'on', value: true },
      { key: 'off', value: false },
    ],
    enabled: true,
    offVariant: 'off',
    prerequisites: [],
    rules: [],
    fallthrough: { variant: 'on' },
    salt: key,
    clientSide: false,
    version: 1,
    ...extra,
  };
}

function ruleset(...flags: Flag[]): Ruleset {
  return {
    environment: 'production',
    version: 10,
    flags: Object.fromEntries(flags.map((f) => [f.key, f])),
    segments: {},
  };
}

const open: (FlagshipClient | StubServer)[] = [];
afterEach(async () => {
  for (const x of open.splice(0)) {
    if (x instanceof FlagshipClient) await x.close();
    else await x.stop();
  }
});

async function setup(
  rs: Ruleset,
  options: Partial<ConstructorParameters<typeof FlagshipClient>[0]> = {},
) {
  const stub = new StubServer(rs);
  await stub.start();
  const client = new FlagshipClient({
    sdkKey: stub.key,
    baseUrl: `${stub.url}/`,
    reconnectMs: { initial: 20, max: 50 },
    pollIntervalMs: 50,
    exposureFlushMs: 60_000,
    ...options,
  });
  open.push(client, stub);
  return { stub, client };
}

const alice = { key: 'alice' };

describe('FlagshipClient', () => {
  it('returns caller defaults until the first ruleset arrives', async () => {
    const client = new FlagshipClient({
      sdkKey: `fss_${'x'.repeat(43)}`,
      baseUrl: 'http://127.0.0.1:1',
      reconnectMs: { initial: 1000, max: 1000 },
      sendExposures: false,
    });
    open.push(client);
    expect(client.status).toBe('initializing');
    expect(client.version).toBeUndefined();
    expect(client.boolDetail('x', alice, true)).toEqual({
      value: true,
      reason: 'ERROR',
      errorCode: 'PROVIDER_NOT_READY',
    });
    expect(await client.ready(100)).toBe(false);
  });

  it('refuses client keys at construction', () => {
    expect(() => new FlagshipClient({ sdkKey: 'fsc_abc', baseUrl: 'http://x' })).toThrow(
      /server key/,
    );
  });

  it('evaluates locally from the streamed ruleset and applies patches as they arrive', async () => {
    const { stub, client } = await setup(
      ruleset(
        flag('checkout'),
        flag('banner', {
          type: 'string',
          variants: [
            { key: 'a', value: 'Hi' },
            { key: 'b', value: 'Hello' },
          ],
          offVariant: 'a',
          fallthrough: { variant: 'b' },
        }),
      ),
    );
    expect(await client.ready()).toBe(true);
    expect(client.status).toBe('ready');
    expect(client.boolVariation('checkout', alice, false)).toBe(true);
    expect(client.stringVariation('banner', alice, 'x')).toBe('Hello');
    expect(client.flagKeys().sort()).toEqual(['banner', 'checkout']);

    const changes: ChangeEvent[] = [];
    client.on('change', (c) => changes.push(c));
    stub.patchFlag('checkout', { enabled: false });
    await until(() => !client.boolVariation('checkout', alice, true));
    expect(changes).toEqual([{ version: 11, flags: ['checkout'], segments: [] }]);
    expect(client.version).toBe(11);

    stub.patchFlag('banner', null);
    await until(() => client.stringDetail('banner', alice, 'x').errorCode === 'FLAG_NOT_FOUND');
  });

  it('reports type mismatches and evaluation errors with the caller default', async () => {
    const { client } = await setup(ruleset(flag('checkout')));
    await client.ready();
    expect(client.stringDetail('checkout', alice, 'no')).toEqual({
      value: 'no',
      reason: 'ERROR',
      errorCode: 'TYPE_MISMATCH',
    });
    expect(client.numberVariation('checkout', alice, 3)).toBe(3);
    expect(client.jsonVariation('checkout', alice, { a: 1 })).toBe(true);
    expect(client.boolDetail('missing', alice, false).errorCode).toBe('FLAG_NOT_FOUND');
    expect(client.boolDetail('checkout', { key: '' }, false).errorCode).toBe('INVALID_CONTEXT');
  });

  it('keeps the last ruleset when the server dies, then resumes with Last-Event-ID', async () => {
    const { stub, client } = await setup(ruleset(flag('checkout')));
    await client.ready();
    const statuses: Status[] = [];
    client.on('status', (s) => statuses.push(s));
    stub.patchFlag('checkout', { fallthrough: { variant: 'off' } });
    await until(() => client.version === 11);

    const port = stub.port;
    await stub.stop();
    await until(() => client.status === 'stale');
    expect(client.boolVariation('checkout', alice, true)).toBe(false);

    stub.ruleset = {
      ...stub.ruleset,
      version: 12,
      flags: { checkout: flag('checkout', { enabled: false }) },
    };
    await stub.start(port);
    await until(() => client.status === 'ready' && client.version === 12, 8000);
    expect(stub.lastEventIds.at(-1)).toBe('11');
    expect(statuses).toContain('stale');
    expect(statuses.at(-1)).toBe('ready');
  });

  it('polls with ETags when streaming is off', async () => {
    const { stub, client } = await setup(ruleset(flag('checkout')), { streaming: false });
    await client.ready();
    await until(() => stub.rulesetRequests >= 3);
    expect(client.version).toBe(10);
    const changes: ChangeEvent[] = [];
    client.on('change', (c) => changes.push(c));
    stub.ruleset = { ...ruleset(flag('checkout', { enabled: false })), version: 11 };
    await until(() => client.version === 11);
    expect(changes[0]).toEqual({ version: 11, flags: ['checkout'], segments: [] });
    expect(client.boolVariation('checkout', alice, true)).toBe(false);
  });

  it('falls back to polling while the stream is refused', async () => {
    const { stub, client } = await setup(ruleset(flag('checkout')));
    stub.streamStatus = 503;
    stub.dropStreams();
    await client.ready();
    await until(() => stub.rulesetRequests >= 1);
    stub.ruleset = { ...ruleset(flag('checkout', { enabled: false })), version: 11 };
    await until(() => client.version === 11, 5000);
  });

  it('ignores invalid rulesets, unknown patch kinds and malformed events', async () => {
    const { stub, client } = await setup(ruleset(flag('checkout')));
    await client.ready();
    const errors: Error[] = [];
    client.on('error', (e) => errors.push(e));
    stub.send('id: 11\nevent: put\ndata: {"environment":"x"}\n\n');
    stub.send('id: 14\nevent: patch\ndata: {"kind":"other","key":"s","value":null}\n\n');
    stub.send('id: 15\nevent: put\ndata: not json\n\n');
    stub.ruleset = { ...stub.ruleset, version: 15 };
    stub.patch('segment', 'beta', {
      key: 'beta',
      included: ['alice'],
      excluded: [],
      rules: [],
      version: 1,
    });
    await until(() => client.version === 16);
    expect(errors).toHaveLength(1);
    expect(client.resyncs).toBe(0);
    expect(client.boolVariation('checkout', alice, false)).toBe(true);
    stub.patch('segment', 'beta', null);
    await until(() => client.version === 17);
    expect(client.checksum).toBe(rulesetChecksum(stub.ruleset));
  });

  it('resyncs instead of skipping a patch it cannot apply', async () => {
    const { stub, client } = await setup(ruleset(flag('checkout')));
    await client.ready();
    const errors: Error[] = [];
    client.on('error', (e) => errors.push(e));
    // The server really changed, but what arrived is not a valid flag.
    stub.patch('flag', 'checkout', flag('checkout', { enabled: false, version: 2 }), {
      send: false,
    });
    stub.send(
      'id: 11\nevent: patch\ndata: {"kind":"flag","key":"checkout","value":{"key":"checkout"}}\n\n',
    );
    await until(() => client.version === 11 && client.status === 'ready');
    expect(client.resyncs).toBe(1);
    expect(errors[0]).toBeInstanceOf(ChecksumError);
    expect(errors[0]?.message).toMatch(/invalid flag patch/);
    expect(stub.lastEventIds.at(-1)).toBeUndefined();
    expect(client.boolVariation('checkout', alice, true)).toBe(false);
  });
});

describe('checksums', () => {
  it('verifies the snapshot and every patch against the checksums the server sends', async () => {
    const { stub, client } = await setup(ruleset(flag('checkout'), flag('banner')));
    await client.ready();
    expect(client.checksum).toBe(rulesetChecksum(stub.ruleset));
    stub.patchFlag('checkout', { enabled: false, version: 2 });
    stub.patch('segment', 'beta', {
      key: 'beta',
      included: [],
      excluded: [],
      rules: [],
      version: 1,
    });
    stub.patchFlag('banner', null);
    await until(() => client.version === 13);
    expect(client.resyncs).toBe(0);
    expect(client.checksum).toBe(rulesetChecksum(stub.ruleset));
    expect(client.flagKeys()).toEqual(['checkout']);
    // A resumed connection carries on from the last verified patch.
    stub.dropStreams();
    await until(() => stub.lastEventIds.length === 2);
    expect(stub.lastEventIds[1]).toBe('13');
  });

  it('notices a lost patch, keeps the last good ruleset and resyncs from a full snapshot', async () => {
    const { stub, client } = await setup(ruleset(flag('checkout'), flag('banner')));
    await client.ready();
    const errors: Error[] = [];
    client.on('error', (e) => errors.push(e));
    stub.patchFlag('checkout', { version: 2 });
    await until(() => client.version === 11);
    // Version 12 never reaches the client; 13 does, but no longer adds up.
    stub.patch('flag', 'banner', flag('banner', { enabled: false, version: 2 }), { send: false });
    stub.patchFlag('checkout', { fallthrough: { variant: 'off' }, version: 3 });
    await until(() => client.resyncs === 1);
    expect(errors[0]).toBeInstanceOf(ChecksumError);
    expect(errors[0]?.message).toMatch(/patch does not match its checksum/);
    // Until the snapshot arrives, the last verified ruleset stays in use.
    expect(client.version === 11 || client.version === 13).toBe(true);
    await until(() => client.version === 13);
    expect(stub.lastEventIds.at(-1)).toBeUndefined();
    expect(client.checksum).toBe(rulesetChecksum(stub.ruleset));
    expect(client.boolVariation('banner', alice, true)).toBe(false);
    expect(client.boolVariation('checkout', alice, true)).toBe(false);
    expect(client.resyncs).toBe(1);
  });

  it('refuses a snapshot that does not match its checksum and recovers once one does', async () => {
    const stub = new StubServer(ruleset(flag('checkout')));
    stub.snapshotChecksum = 'f'.repeat(64);
    await stub.start();
    const client = new FlagshipClient({
      sdkKey: stub.key,
      baseUrl: stub.url,
      reconnectMs: { initial: 20, max: 50 },
      pollIntervalMs: 50,
      sendExposures: false,
    });
    open.push(client, stub);
    await until(() => client.resyncs >= 2);
    expect(client.status).toBe('initializing');
    expect(client.boolDetail('checkout', alice, false).errorCode).toBe('PROVIDER_NOT_READY');
    stub.snapshotChecksum = undefined;
    expect(await client.ready()).toBe(true);
    expect(client.checksum).toBe(rulesetChecksum(stub.ruleset));
  });

  it('backs off while every snapshot keeps failing its checksum', async () => {
    const stub = new StubServer(ruleset(flag('checkout')));
    stub.snapshotChecksum = 'f'.repeat(64);
    await stub.start();
    const client = new FlagshipClient({
      sdkKey: stub.key,
      baseUrl: stub.url,
      reconnectMs: { initial: 20, max: 1000 },
      pollIntervalMs: 60_000,
      sendExposures: false,
    });
    open.push(client, stub);
    await new Promise((r) => setTimeout(r, 700));
    // Without backoff a 20 ms reconnect would connect about 35 times here;
    // doubling from 20 ms (jittered down to half) allows at most 7.
    expect(stub.lastEventIds.length).toBeGreaterThanOrEqual(3);
    expect(stub.lastEventIds.length).toBeLessThanOrEqual(7);
  });

  it('polling drops its ETag after a bad snapshot, so the next poll fetches it whole', async () => {
    const { stub, client } = await setup(ruleset(flag('checkout')), { streaming: false });
    await client.ready();
    stub.ruleset = { ...ruleset(flag('checkout', { enabled: false, version: 2 })), version: 11 };
    stub.snapshotChecksum = '0'.repeat(64);
    await until(() => client.resyncs >= 1);
    expect(client.version).toBe(10);
    expect(client.status).toBe('stale');
    stub.snapshotChecksum = undefined;
    await until(() => client.version === 11);
    expect(client.status).toBe('ready');
    expect(client.checksum).toBe(rulesetChecksum(stub.ruleset));
  });

  it('still applies snapshots and patches from a server that sends no checksums', async () => {
    const stub = new StubServer(ruleset(flag('checkout')));
    stub.checksums = false;
    await stub.start();
    const client = new FlagshipClient({
      sdkKey: stub.key,
      baseUrl: stub.url,
      sendExposures: false,
    });
    open.push(client, stub);
    await client.ready();
    stub.patchFlag('checkout', { enabled: false, version: 2 });
    await until(() => client.version === 11);
    expect(client.resyncs).toBe(0);
    expect(client.checksum).toBe(rulesetChecksum(stub.ruleset));
    expect(client.boolVariation('checkout', alice, true)).toBe(false);
  });
});

describe('FlagshipClient connections', () => {
  it('stops trying when the key is refused', async () => {
    const stub = new StubServer(ruleset(flag('checkout')));
    await stub.start();
    open.push(stub);
    const client = new FlagshipClient({ sdkKey: `fss_${'z'.repeat(43)}`, baseUrl: stub.url });
    open.push(client);
    const error = await new Promise<Error>((resolve) => client.on('error', resolve));
    expect(error.message).toMatch(/refused the SDK key \(401\)/);
    const poller = new FlagshipClient({
      sdkKey: `fss_${'z'.repeat(43)}`,
      baseUrl: stub.url,
      streaming: false,
    });
    open.push(poller);
    const pollError = await new Promise<Error>((resolve) => poller.on('error', resolve));
    expect(pollError.message).toMatch(/401/);
  });

  it('sends aggregated exposure counts and keeps them through a 429', async () => {
    const { stub, client } = await setup(
      ruleset(flag('checkout'), flag('other', { enabled: false })),
    );
    await client.ready();
    for (let i = 0; i < 5; i++) client.boolVariation('checkout', { key: `u${i}` }, false);
    client.boolVariation('other', alice, false);
    client.boolVariation('missing', alice, false);
    stub.eventsStatus = 429;
    await client.flush();
    expect(stub.events).toEqual([]);
    await client.flush();
    stub.eventsStatus = 202;
    await new Promise((r) => setTimeout(r, 1100));
    await client.flush();
    expect(stub.events).toEqual([
      { flag: 'checkout', variant: 'on', count: 5, at: expect.any(Number) },
      { flag: 'other', variant: 'off', count: 1, at: expect.any(Number) },
    ]);
  });

  it('bounds the exposure buffer and flushes on close', async () => {
    const { stub, client } = await setup(ruleset(flag('a'), flag('b'), flag('c')), {
      maxExposureKeys: 2,
    });
    await client.ready();
    client.boolVariation('a', alice, false);
    client.boolVariation('b', alice, false);
    client.boolVariation('c', alice, false);
    expect(client.droppedExposures).toBe(1);
    await client.close();
    expect(stub.events).toHaveLength(2);
    expect(client.status).toBe('closed');
    expect(await client.ready()).toBe(true);
    await client.close();
  });

  it('drops counts that no longer fit after a failed flush, and gives up on rejected batches', async () => {
    const { stub, client } = await setup(ruleset(flag('a'), flag('b')), { maxExposureKeys: 1 });
    await client.ready();
    client.boolVariation('a', alice, false);
    stub.eventsStatus = 500;
    await client.flush();
    client.boolVariation('b', alice, false);
    expect(client.droppedExposures).toBe(1);
    stub.eventsStatus = 400;
    await new Promise((r) => setTimeout(r, 2100));
    await client.flush();
    expect(stub.events).toEqual([]);
  });

  const split = (key: string) =>
    flag(key, {
      fallthrough: {
        rollout: {
          variants: [
            { variant: 'on', weight: 50_000 },
            { variant: 'off', weight: 50_000 },
          ],
        },
      },
    });

  it('reports a first exposure once per context, only for contexts a split bucketed', async () => {
    const { stub, client } = await setup(ruleset(split('exp'), flag('fixed')));
    await client.ready();
    const served = new Map<string, string | undefined>();
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 200; i++) {
        const d = client.boolDetail('exp', { key: `u${i}` }, false);
        expect(d.reason).toBe('SPLIT');
        served.set(`u${i}`, d.variant);
        client.boolVariation('fixed', { key: `u${i}` }, false);
      }
    }
    await client.flush();
    const exposures = stub.bodies.flatMap((b) => b.exposures ?? []) as {
      flag: string;
      variant: string;
      key: string;
      at: number;
    }[];
    expect(exposures).toHaveLength(200);
    for (const e of exposures) {
      expect(e.flag).toBe('exp');
      expect(e.variant).toBe(served.get(e.key));
      expect(typeof e.at).toBe('number');
    }
    expect(new Set(served.values())).toEqual(new Set(['on', 'off']));
    // Counts still cover every evaluation, of both flags.
    expect(stub.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ flag: 'fixed', variant: 'on', count: 600 }),
      ]),
    );
    // Already reported: evaluating again sends nothing new.
    client.boolVariation('exp', { key: 'u1' }, false);
    await client.flush();
    expect(stub.bodies.flatMap((b) => b.exposures ?? [])).toHaveLength(200);
  });

  it('forgets the oldest reported contexts past maxSeenContexts and reports them again', async () => {
    const { stub, client } = await setup(ruleset(split('exp')), { maxSeenContexts: 2 });
    await client.ready();
    for (const key of ['a', 'b', 'c']) client.boolVariation('exp', { key }, false);
    await client.flush();
    client.boolVariation('exp', { key: 'c' }, false); // still remembered
    client.boolVariation('exp', { key: 'a' }, false); // forgotten when c came in
    await client.flush();
    expect(
      stub.bodies.flatMap((b) => (b.exposures ?? []) as { key: string }[]).map((e) => e.key),
    ).toEqual(['a', 'b', 'c', 'a']);
  });

  it('tracks conversions with ids and values, and keeps them through a 429', async () => {
    const { stub, client } = await setup(ruleset(split('exp')), { sendExposures: false });
    await client.ready();
    client.boolVariation('exp', alice, false);
    expect(client.track('purchase', alice, 25.5)).toBe(true);
    expect(client.track('signup', { key: 'bob' })).toBe(true);
    stub.eventsStatus = 429;
    await client.flush();
    expect(stub.bodies).toEqual([]);
    stub.eventsStatus = 202;
    await new Promise((r) => setTimeout(r, 1100));
    await client.flush();
    // sendExposures: false turns off exposure reporting, not conversions.
    expect(stub.bodies).toEqual([
      {
        conversions: [
          {
            id: expect.any(String),
            event: 'purchase',
            key: 'alice',
            value: 25.5,
            at: expect.any(Number),
          },
          { id: expect.any(String), event: 'signup', key: 'bob', at: expect.any(Number) },
        ],
      },
    ]);
    const [a, b] = stub.bodies[0]?.conversions as { id: string }[];
    expect(a?.id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(a?.id).not.toBe(b?.id);
  });

  it('refuses invalid conversions and bounds the event buffer', async () => {
    const { stub, client } = await setup(ruleset(split('exp')), { maxEvents: 2 });
    await client.ready();
    expect(client.track('../bad', alice)).toBe(false);
    expect(client.track('purchase', { key: '' })).toBe(false);
    expect(client.track('purchase', { key: 'k'.repeat(1025) })).toBe(false);
    expect(client.track('purchase', alice, Number.NaN)).toBe(false);
    expect(client.track('purchase', alice, 1e16)).toBe(false);
    expect(client.droppedEvents).toBe(0);
    client.boolVariation('exp', alice, false); // one first exposure
    expect(client.track('purchase', alice)).toBe(true);
    expect(client.track('purchase', alice)).toBe(false);
    client.boolVariation('exp', { key: 'bob' }, false);
    expect(client.droppedEvents).toBe(2);
    stub.eventsStatus = 500;
    await client.flush();
    // While the batch waits to be retried, newer events can't push it out.
    expect(client.track('purchase', alice)).toBe(false);
    expect(client.droppedEvents).toBe(3);
    stub.eventsStatus = 202;
    await client.close();
    expect(client.track('purchase', alice)).toBe(false);
    expect(stub.events.reduce((n: number, e) => n + (e as { count: number }).count, 0)).toBe(2);
    expect(stub.bodies).toEqual([
      {
        events: expect.any(Array),
        exposures: [expect.objectContaining({ key: 'alice' })],
        conversions: [expect.objectContaining({ key: 'alice' })],
      },
    ]);
  });

  it('splits large batches into requests the server accepts', () => {
    const long = 'k'.repeat(1024);
    const batch: EventBatch = {
      events: Array.from({ length: 700 }, (_, i) => ({
        flag: `f${i}`,
        variant: 'on',
        count: 1,
        at: 0,
      })),
      exposures: Array.from({ length: 700 }, (_, i) => ({
        flag: 'exp',
        variant: 'on',
        key: `${long.slice(4)}${String(i).padStart(4, '0')}`,
        at: 0,
      })),
      conversions: Array.from({ length: 10 }, (_, i) => ({
        id: `id-${String(i).padStart(8, '0')}`,
        event: 'purchase',
        key: 'u',
        at: 0,
      })),
    };
    const requests = packEvents(batch);
    let total = 0;
    for (const r of requests) {
      const n = (r.events?.length ?? 0) + (r.exposures?.length ?? 0) + (r.conversions?.length ?? 0);
      expect(n).toBeGreaterThan(0);
      expect(n).toBeLessThanOrEqual(1000);
      expect(JSON.stringify(r).length).toBeLessThan(256 * 1024);
      for (const list of [r.events, r.exposures, r.conversions]) {
        if (list !== undefined) expect(list.length).toBeGreaterThan(0);
      }
      total += n;
    }
    expect(total).toBe(1410);
    expect(requests.flatMap((r) => r.exposures ?? []).map((e) => e.key)).toEqual(
      batch.exposures.map((e) => e.key),
    );
    expect(packEvents({ events: [], exposures: [], conversions: [] })).toEqual([]);
  });

  it('reconnects when the stream goes silent', async () => {
    const { stub, client } = await setup(ruleset(flag('checkout')), { streamIdleTimeoutMs: 200 });
    await client.ready();
    await until(() => stub.lastEventIds.length >= 2, 3000);
    expect(stub.lastEventIds[1]).toBe('10');
  });
});
