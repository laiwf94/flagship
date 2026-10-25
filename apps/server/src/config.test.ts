import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

const url = 'postgres://u:p@localhost:5432/flagship';

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig({ FLAGSHIP_DATABASE_URL: url });
    expect(c).toMatchObject({
      databaseUrl: url,
      host: '0.0.0.0',
      port: 8080,
      logLevel: 'info',
      trustProxy: false,
      cookieSecure: 'auto',
      allowedOrigins: [],
      bootstrapAdmin: undefined,
      metricsToken: undefined,
      maxStreams: 20_000,
    });
  });

  it('parses every setting', () => {
    const c = loadConfig({
      FLAGSHIP_DATABASE_URL: url,
      FLAGSHIP_PORT: '9000',
      FLAGSHIP_TRUST_PROXY: '1',
      FLAGSHIP_COOKIE_SECURE: 'true',
      FLAGSHIP_ALLOWED_ORIGINS: 'https://flags.acme.com/, http://localhost:5173',
      FLAGSHIP_ADMIN_EMAIL: 'Admin@Acme.com',
      FLAGSHIP_ADMIN_PASSWORD: 'correct horse battery',
      FLAGSHIP_METRICS_TOKEN: 'a-long-metrics-token',
      FLAGSHIP_ADMIN_UI_DIR: '/srv/admin',
    });
    expect(c).toMatchObject({
      port: 9000,
      trustProxy: true,
      cookieSecure: 'true',
      allowedOrigins: ['https://flags.acme.com', 'http://localhost:5173'],
      bootstrapAdmin: { email: 'admin@acme.com', password: 'correct horse battery' },
      metricsToken: 'a-long-metrics-token',
      adminUiDir: '/srv/admin',
    });
  });

  it('lists every problem at once', () => {
    try {
      loadConfig({
        FLAGSHIP_DATABASE_URL: 'mysql://x',
        FLAGSHIP_PORT: '70000',
        FLAGSHIP_ADMIN_EMAIL: 'admin@acme.com',
        FLAGSHIP_METRICS_TOKEN: 'short',
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const problems = (err as ConfigError).problems.join('\n');
      expect(problems).toContain('FLAGSHIP_DATABASE_URL: must be a postgres:// URL');
      expect(problems).toContain('FLAGSHIP_PORT');
      expect(problems).toContain('FLAGSHIP_METRICS_TOKEN: must be at least 16 characters');
    }
  });

  it('requires the bootstrap email and password together', () => {
    expect(() =>
      loadConfig({ FLAGSHIP_DATABASE_URL: url, FLAGSHIP_ADMIN_EMAIL: 'a@acme.com' }),
    ).toThrow(/set both FLAGSHIP_ADMIN_EMAIL and FLAGSHIP_ADMIN_PASSWORD/);
    expect(() =>
      loadConfig({ FLAGSHIP_DATABASE_URL: url, FLAGSHIP_ALLOWED_ORIGINS: 'not a url' }),
    ).toThrow(ConfigError);
  });
});
