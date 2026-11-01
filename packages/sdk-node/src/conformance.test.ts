import { loadCases, mismatch, type Observed } from '@flagship/conformance';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StubServer, until } from '../test/stub.js';
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

describe.each(loadCases().filter((c) => c.checksum !== undefined))(
  'checksums through the Node SDK: $name',
  ({ ruleset, checksum, patches }) => {
    it('verifies the snapshot and every patch without a resync', async () => {
      const stub = new StubServer(ruleset);
      await stub.start();
      const client = new FlagshipClient({
        sdkKey: stub.key,
        baseUrl: stub.url,
        sendExposures: false,
      });
      try {
        expect(await client.ready()).toBe(true);
        expect(client.checksum).toBe(checksum);
        for (const p of patches ?? []) {
          stub.patch(p.kind, p.key, p.value, { checksum: p.checksum });
          await until(() => client.version === p.version);
          expect(client.checksum).toBe(p.checksum);
        }
        expect(client.resyncs).toBe(0);
      } finally {
        await client.close();
        await stub.stop();
      }
    });
  },
);
