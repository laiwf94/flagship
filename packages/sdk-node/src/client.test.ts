import type { Flag, Ruleset } from '@flagship/core';
import { afterEach, describe, expect, it } from 'vitest';
import { StubServer, until } from '../test/stub.js';
import { FlagshipClient, type ChangeEvent, type Status } from './client.js';

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

  it('ignores invalid rulesets, bad patches and malformed events', async () => {
    const { stub, client } = await setup(ruleset(flag('checkout')));
    await client.ready();
    const errors: Error[] = [];
    client.on('error', (e) => errors.push(e));
    stub.send('id: 11\nevent: put\ndata: {"environment":"x"}\n\n');
    stub.send(
      'id: 12\nevent: patch\ndata: {"kind":"flag","key":"checkout","value":{"key":"checkout"}}\n\n',
    );
    stub.send('id: 13\nevent: patch\ndata: {"kind":"segment","key":"s","value":{"bad":true}}\n\n');
    stub.send('id: 14\nevent: patch\ndata: {"kind":"other","key":"s","value":null}\n\n');
    stub.send('id: 15\nevent: put\ndata: not json\n\n');
    stub.send(
      `id: 16\nevent: patch\ndata: ${JSON.stringify({ kind: 'segment', key: 'beta', value: { key: 'beta', included: ['alice'], excluded: [], rules: [], version: 1 } })}\n\n`,
    );
    await until(() => client.version === 16);
    expect(errors).toHaveLength(1);
    expect(client.boolVariation('checkout', alice, false)).toBe(true);
    stub.send(
      `id: 17\nevent: patch\ndata: ${JSON.stringify({ kind: 'segment', key: 'beta', value: null })}\n\n`,
    );
    await until(() => client.version === 17);
  });

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

  it('reconnects when the stream goes silent', async () => {
    const { stub, client } = await setup(ruleset(flag('checkout')), { streamIdleTimeoutMs: 200 });
    await client.ready();
    await until(() => stub.lastEventIds.length >= 2, 3000);
    expect(stub.lastEventIds[1]).toBe('10');
  });
});
