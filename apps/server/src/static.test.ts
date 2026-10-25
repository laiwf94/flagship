import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApp, type TestApp } from '../test/app.js';

let t: TestApp;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ui-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>flagship</title>');
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
  t = await testApp({ adminUiDir: dir });
});
afterAll(() => t.close());

describe('admin UI hosting', () => {
  it('serves assets and falls back to index.html for client-side routes', async () => {
    const asset = await t.app.server.inject({ url: '/assets/app.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['content-type']).toContain('javascript');
    for (const url of ['/', '/p/default/production/flags/new-checkout?tab=history']) {
      const page = await t.app.server.inject({ url });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('<title>flagship</title>');
      expect(page.headers['cache-control']).toBe('no-cache');
    }
  });

  it('answers HEAD for client-side routes too', async () => {
    const head = await t.app.server.inject({ method: 'HEAD', url: '/p/default/production/flags' });
    expect(head.statusCode).toBe(200);
  });

  it('keeps JSON 404s for the API and sends security headers everywhere', async () => {
    const api = await t.app.server.inject({ url: '/api/nope' });
    expect(api.statusCode).toBe(404);
    expect(api.json().error.code).toBe('not_found');
    expect((await t.app.server.inject({ url: '/sdk/v1/nope' })).statusCode).toBe(404);
    expect((await t.app.server.inject({ method: 'POST', url: '/somewhere' })).statusCode).toBe(404);
    const page = await t.app.server.inject({ url: '/' });
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    const traversal = await t.app.server.inject({ url: '/assets/../../etc/passwd' });
    expect(traversal.body).not.toContain('root:');
  });
});
