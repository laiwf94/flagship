import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApp, type TestApp } from '../test/app.js';
import { redactUrl } from './log.js';

let t: TestApp;

beforeAll(async () => {
  t = await testApp();
});
afterAll(() => t.close());

describe('app basics', () => {
  it('answers health and readiness', async () => {
    const health = await t.app.server.inject({ url: '/healthz' });
    expect(health.json()).toEqual({ status: 'ok' });
    const ready = await t.app.server.inject({ url: '/readyz' });
    expect(ready.json()).toEqual({ status: 'ready' });
  });

  it('echoes a well-formed request id and replaces a malformed one', async () => {
    const given = await t.app.server.inject({
      url: '/healthz',
      headers: { 'x-request-id': 'abc-123' },
    });
    expect(given.headers['x-request-id']).toBe('abc-123');
    const bad = await t.app.server.inject({
      url: '/healthz',
      headers: { 'x-request-id': 'has spaces and <html>' },
    });
    expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns the error body for unknown routes', async () => {
    const res = await t.app.server.inject({ url: '/nope?x=1' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toEqual({
      code: 'not_found',
      message: 'no route for GET /nope',
      request_id: res.headers['x-request-id'],
    });
  });

  it('serves metrics to loopback only when no token is set', async () => {
    const local = await t.app.server.inject({ url: '/metrics', remoteAddress: '127.0.0.1' });
    expect(local.statusCode).toBe(200);
    expect(local.headers['content-type']).toContain('text/plain; version=0.0.4');
    expect(local.body).toContain(
      'flagship_http_requests_total{method="GET",route="/healthz",status="200"}',
    );
    const remote = await t.app.server.inject({ url: '/metrics', remoteAddress: '10.0.0.8' });
    expect(remote.statusCode).toBe(403);
  });

  it('logs requests without leaking keys in URLs', async () => {
    await t.app.server.inject({ url: '/healthz?key=fsc_supersecret&x=1' });
    const lines = t.logs.join('');
    expect(lines).not.toContain('fsc_supersecret');
    expect(lines).toContain('key=[redacted]');
    expect(redactUrl('/s?a=1&key=abc#f')).toBe('/s?a=1&key=[redacted]#f');
  });
});

describe('metrics with a token', () => {
  it('requires the bearer token from anywhere', async () => {
    const withToken = await testApp({ metricsToken: 'a-long-metrics-token' });
    try {
      const none = await withToken.app.server.inject({
        url: '/metrics',
        remoteAddress: '127.0.0.1',
      });
      expect(none.statusCode).toBe(401);
      const ok = await withToken.app.server.inject({
        url: '/metrics',
        remoteAddress: '10.0.0.8',
        headers: { authorization: 'Bearer a-long-metrics-token' },
      });
      expect(ok.statusCode).toBe(200);
    } finally {
      await withToken.close();
    }
  });
});

describe('shutdown and failures', () => {
  it('reports unready when the database is gone and 503 while draining', async () => {
    const other = await testApp();
    await other.db.destroy();
    const ready = await other.app.server.inject({ url: '/readyz' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json().error.message).toBe('database is unreachable');
    await other.app.close();
    await other.close().catch(() => undefined);
  });
});
