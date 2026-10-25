import { createClient } from '@flagship/browser';
import { loadCases, mismatch, type Observed } from '@flagship/conformance';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApp, type TestApp } from '../test/app.js';
import { PASSWORD, signIn, type Client } from '../test/session.js';
import { seedRuleset } from '../test/seed.js';

let t: TestApp;
let admin: Client;
let base: string;

beforeAll(async () => {
  t = await testApp({ bootstrapAdmin: { email: 'root@example.com', password: PASSWORD } });
  admin = await signIn(t.app.server, 'root@example.com');
  await t.app.server.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(t.app.server.server.address() as AddressInfo).port}`;
});
afterAll(() => t.close());

async function clientKey(project: string, env: string): Promise<string> {
  const res = await admin.request('POST', `/api/projects/${project}/environments/${env}/api-keys`, {
    kind: 'client',
    name: 'web',
  });
  return res.json().secret;
}

describe('browser SDK against the real server', () => {
  it('accepts exposure counts sent by sendBeacon as text/plain with the key in the query', async () => {
    const key = await clientKey('default', 'production');
    const res = await fetch(`${base}/sdk/v1/events?key=${key}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ events: [{ flag: 'x', variant: 'on', count: 2 }] }),
    });
    expect(res.status).toBe(202);
    const bad = await fetch(`${base}/sdk/v1/events?key=${key}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'not json',
    });
    expect(bad.status).toBe(400);
  });
});

describe.each(loadCases())(
  'conformance through the browser SDK: $name',
  ({ name, ruleset, tests }) => {
    let key: string;
    beforeAll(async () => {
      await seedRuleset(t.db, `browser-${name}`, ruleset, { clientSide: true });
      key = await clientKey(`browser-${name}`, ruleset.environment);
    });

    it.each(tests)('$name', async ({ flag, context, expect: expected }) => {
      const c = createClient({
        clientKey: key,
        baseUrl: base,
        context: context as { key: string },
        streaming: false,
        sendExposures: false,
      });
      try {
        expect(await c.ready()).toBe(true);
        const d = c.detail(flag, null);
        const observed: Observed =
          d.reason === 'ERROR'
            ? { reason: 'ERROR', errorCode: d.errorCode ?? '' }
            : { reason: d.reason, variant: d.variant ?? '', value: d.value };
        expect(mismatch(expected, observed)).toBeUndefined();
      } finally {
        c.close();
      }
    });
  },
);
