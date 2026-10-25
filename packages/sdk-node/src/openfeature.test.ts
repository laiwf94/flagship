import type { Flag, Ruleset } from '@flagship/core';
import { OpenFeature, ProviderEvents } from '@openfeature/server-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StubServer, until } from '../test/stub.js';
import { FlagshipClient } from './client.js';
import { FlagshipProvider, toContext } from './openfeature.js';

const base = (key: string, extra: Partial<Flag>): Flag => ({
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
});

const rs: Ruleset = {
  environment: 'production',
  version: 1,
  segments: {},
  flags: {
    checkout: base('checkout', {
      rules: [
        {
          id: 'pros',
          clauses: [{ attribute: 'plan', operator: 'equals', values: ['pro'] }],
          serve: { variant: 'off' },
        },
      ],
    }),
    banner: base('banner', {
      type: 'string',
      variants: [
        { key: 'a', value: 'Hi' },
        { key: 'b', value: 'Hello' },
      ],
      offVariant: 'a',
      fallthrough: { variant: 'b' },
    }),
    limit: base('limit', {
      type: 'number',
      variants: [
        { key: 'low', value: 10 },
        { key: 'high', value: 100 },
      ],
      offVariant: 'low',
      fallthrough: { variant: 'high' },
    }),
    theme: base('theme', {
      type: 'json',
      variants: [
        { key: 'light', value: { bg: '#fff' } },
        { key: 'dark', value: { bg: '#000' } },
      ],
      offVariant: 'light',
      fallthrough: { variant: 'dark' },
    }),
  },
};

const stub = new StubServer(rs);
let provider: FlagshipProvider;

beforeAll(async () => {
  await stub.start();
  provider = new FlagshipProvider({ sdkKey: stub.key, baseUrl: stub.url, sendExposures: false });
  await OpenFeature.setProviderAndWait(provider);
});
afterAll(async () => {
  await OpenFeature.close();
  await stub.stop();
});

describe('FlagshipProvider through the OpenFeature SDK', () => {
  const client = () => OpenFeature.getClient();

  it('resolves every type with OpenFeature reasons and variants', async () => {
    const ctx = { targetingKey: 'alice' };
    expect(await client().getBooleanDetails('checkout', false, ctx)).toMatchObject({
      value: true,
      variant: 'on',
      reason: 'DEFAULT',
      flagKey: 'checkout',
    });
    expect(
      await client().getBooleanDetails('checkout', true, { ...ctx, plan: 'pro' }),
    ).toMatchObject({
      value: false,
      reason: 'TARGETING_MATCH',
      flagMetadata: { ruleId: 'pros' },
    });
    expect(await client().getStringValue('banner', 'x', ctx)).toBe('Hello');
    expect(await client().getNumberValue('limit', 0, ctx)).toBe(100);
    expect(await client().getObjectValue('theme', {}, ctx)).toEqual({ bg: '#000' });
  });

  it('maps errors to OpenFeature error codes and returns the default', async () => {
    const ctx = { targetingKey: 'alice' };
    expect(await client().getBooleanDetails('missing', true, ctx)).toMatchObject({
      value: true,
      reason: 'ERROR',
      errorCode: 'FLAG_NOT_FOUND',
    });
    expect(await client().getStringDetails('checkout', 'd', ctx)).toMatchObject({
      value: 'd',
      errorCode: 'TYPE_MISMATCH',
    });
    expect(await client().getObjectDetails('banner', { d: 1 }, ctx)).toMatchObject({
      value: { d: 1 },
      errorCode: 'TYPE_MISMATCH',
    });
    expect(await client().getObjectDetails('missing', { d: 1 }, ctx)).toMatchObject({
      errorCode: 'FLAG_NOT_FOUND',
    });
    expect(await client().getBooleanDetails('checkout', true, {})).toMatchObject({
      value: true,
      errorCode: 'TARGETING_KEY_MISSING',
    });
  });

  it('emits configuration-changed when the ruleset changes', async () => {
    const changed: string[][] = [];
    OpenFeature.addHandler(ProviderEvents.ConfigurationChanged, (e) => {
      changed.push((e?.flagsChanged as string[] | undefined) ?? []);
    });
    stub.patchFlag('checkout', { enabled: false });
    await until(() => changed.length > 0);
    expect(changed[0]).toEqual(['checkout']);
    expect(await client().getBooleanValue('checkout', true, { targetingKey: 'alice' })).toBe(false);
  });

  it('reports stale and ready as the server goes away and comes back', async () => {
    const p = new FlagshipProvider(
      new FlagshipClient({
        sdkKey: stub.key,
        baseUrl: stub.url,
        sendExposures: false,
        reconnectMs: { initial: 20, max: 40 },
        pollIntervalMs: 50,
      }),
    );
    const seenOwn: string[] = [];
    p.events.addHandler(ProviderEvents.Stale, () => seenOwn.push('stale'));
    p.events.addHandler(ProviderEvents.Ready, () => seenOwn.push('ready'));
    await p.initialize();
    const port = stub.port;
    await stub.stop();
    await until(() => seenOwn.includes('stale'));
    await stub.start(port);
    await until(() => seenOwn.at(-1) === 'ready', 8000);
    await p.onClose();
  });

  it('fails initialisation when no ruleset arrives in time', async () => {
    const p = new FlagshipProvider(
      { sdkKey: stub.key, baseUrl: 'http://127.0.0.1:1', sendExposures: false },
      100,
    );
    await expect(p.initialize()).rejects.toThrow(/no ruleset/);
    await p.onClose();
  });
});

describe('toContext', () => {
  it('maps targetingKey and flattens attributes', () => {
    const when = new Date('2030-01-02T03:04:05Z');
    expect(
      toContext({
        targetingKey: 'alice',
        key: 'ignored',
        plan: 'pro',
        seats: 5,
        beta: true,
        nothing: null,
        signedUp: when,
        tags: ['a', 1, { x: 1 }, when],
        nested: { a: 1 },
        nan: Number.NaN,
      }),
    ).toEqual({
      key: 'alice',
      plan: 'pro',
      seats: 5,
      beta: true,
      nothing: null,
      signedUp: '2030-01-02T03:04:05.000Z',
      tags: ['a', 1, '2030-01-02T03:04:05.000Z'],
    });
    expect(toContext({ plan: 'pro' })).toBeUndefined();
    expect(toContext({ targetingKey: '' })).toBeUndefined();
  });
});
