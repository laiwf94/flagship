import { loadCases, mismatch, type Observed } from '@flagship/conformance';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApp, type TestApp } from '../../test/app.js';
import { PASSWORD, signIn, type Client } from '../../test/session.js';
import { seedRuleset } from '../../test/seed.js';

let t: TestApp;
let admin: Client;
let clientKey: string;
let serverKey: string;

const P = '/api/projects/default';

const evaluate = (key: string, body: unknown) =>
  t.app.server.inject({
    method: 'POST',
    url: '/sdk/v1/evaluate',
    headers: { authorization: `Bearer ${key}` },
    payload: body as object,
  });

async function keysFor(project: string, env: string) {
  const url = `/api/projects/${project}/environments/${env}/api-keys`;
  const client = (await admin.request('POST', url, { kind: 'client', name: 'web' })).json().secret;
  const server = (await admin.request('POST', url, { kind: 'server', name: 'svc' })).json().secret;
  return { client, server };
}

beforeAll(async () => {
  t = await testApp({ bootstrapAdmin: { email: 'root@example.com', password: PASSWORD } });
  admin = await signIn(t.app.server, 'root@example.com');
  ({ client: clientKey, server: serverKey } = await keysFor('default', 'production'));

  for (const [key, clientSide] of [
    ['web-banner', true],
    ['internal-tool', false],
  ] as const) {
    await admin.request('POST', `${P}/flags`, { key, name: key, type: 'boolean', clientSide });
  }
  await admin.request('POST', `${P}/environments/production/segments`, {
    key: 'secret-vip-list',
    name: 'VIPs',
    included: ['alice-the-vip'],
    excluded: [],
    rules: [],
  });
  const flag = (await admin.request('GET', `${P}/flags/web-banner`)).json();
  const res = await admin.request('PUT', `${P}/flags/web-banner/environments/production`, {
    version: flag.version,
    enabled: true,
    offVariant: 'off',
    prerequisites: [],
    rules: [
      {
        id: 'vip-rule-id',
        clauses: [{ operator: 'inSegment', segments: ['secret-vip-list'] }],
        serve: { variant: 'on' },
      },
      {
        id: 'employees',
        clauses: [
          { attribute: 'email', operator: 'endsWith', values: ['@internal-domain.example'] },
        ],
        serve: { variant: 'on' },
      },
    ],
    fallthrough: { variant: 'off' },
  });
  expect(res.statusCode, res.body).toBe(200);
});
afterAll(() => t.close());

describe('POST /sdk/v1/evaluate', () => {
  it('returns values for client-side flags only, with nothing that reveals the rules', async () => {
    const res = await evaluate(clientKey, { context: { key: 'bob', email: 'bob@shop.example' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['access-control-allow-origin']).toBe('*');
    const body = res.json();
    expect(body).toEqual({
      version: expect.any(Number),
      flags: { 'web-banner': { value: false, variant: 'off', reason: 'DEFAULT' } },
    });
    for (const secret of [
      'alice-the-vip',
      'secret-vip-list',
      'vip-rule-id',
      'employees',
      'internal-domain',
      'internal-tool',
      'clauses',
      'rollout',
    ]) {
      expect(res.body).not.toContain(secret);
    }
  });

  it('gives a member of a hidden segment the targeted value without saying why beyond the reason', async () => {
    const res = await evaluate(clientKey, { context: { key: 'alice-the-vip' } });
    expect(res.json().flags['web-banner']).toEqual({
      value: true,
      variant: 'on',
      reason: 'TARGETING_MATCH',
    });
    expect(res.body.match(/alice-the-vip/g)).toBeNull();
  });

  it('lets server keys see every flag', async () => {
    const res = await evaluate(serverKey, { context: { key: 'bob' } });
    expect(Object.keys(res.json().flags).sort()).toEqual(['internal-tool', 'web-banner']);
  });

  it('validates the context', async () => {
    for (const body of [
      {},
      { context: {} },
      { context: { key: '' } },
      { context: { key: 'a', nested: { x: 1 } } },
      { context: { key: 'a', long: 'x'.repeat(2000) } },
      { context: { key: 'a' }, extra: true },
    ]) {
      expect((await evaluate(clientKey, body)).statusCode).toBe(400);
    }
    const huge = await evaluate(clientKey, { context: { key: 'a', blob: 'x'.repeat(70_000) } });
    expect(huge.statusCode).toBe(413);
    const anon = await t.app.server.inject({
      method: 'POST',
      url: '/sdk/v1/evaluate',
      payload: { context: { key: 'a' } },
    });
    expect(anon.statusCode).toBe(401);
  });

  it('never logs the context', async () => {
    await evaluate(clientKey, {
      context: { key: 'carol-private-id', email: 'carol@private.example' },
    });
    const logs = t.logs.join('');
    expect(logs).not.toContain('carol-private-id');
    expect(logs).not.toContain('carol@private.example');
  });
});

const cases = loadCases();

describe.each(cases)('conformance through HTTP: $name', ({ name, ruleset, tests }) => {
  let key: string;
  beforeAll(async () => {
    await seedRuleset(t.db, `conf-${name}`, ruleset, { clientSide: true });
    key = (await keysFor(`conf-${name}`, ruleset.environment)).client;
  });

  it.each(tests)('$name', async ({ flag, context, expect: expected }) => {
    const res = await evaluate(key, { context });
    expect(res.statusCode, res.body).toBe(200);
    const got = res.json().flags[flag] as Observed | undefined;
    const observed: Observed = got ?? { reason: 'ERROR', errorCode: 'FLAG_NOT_FOUND' };
    expect(mismatch(expected, observed)).toBeUndefined();
  });
});
