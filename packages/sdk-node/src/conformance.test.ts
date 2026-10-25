import { loadCases, mismatch, type Observed } from '@flagship/conformance';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StubServer } from '../test/stub.js';
import { FlagshipClient } from './client.js';

describe.each(loadCases())('conformance through the Node SDK: $name', ({ ruleset, tests }) => {
  const stub = new StubServer(ruleset);
  let client: FlagshipClient;
  beforeAll(async () => {
    await stub.start();
    client = new FlagshipClient({ sdkKey: stub.key, baseUrl: stub.url, sendExposures: false });
    expect(await client.ready()).toBe(true);
  });
  afterAll(async () => {
    await client.close();
    await stub.stop();
  });

  it.each(tests)('$name', ({ flag, context, expect: expected }) => {
    const d = client.jsonDetail(flag, context as { key: string }, null);
    const observed: Observed =
      d.reason === 'ERROR'
        ? { reason: 'ERROR', errorCode: d.errorCode ?? '' }
        : { reason: d.reason, variant: d.variant ?? '', value: d.value };
    expect(mismatch(expected, observed)).toBeUndefined();
  });
});
