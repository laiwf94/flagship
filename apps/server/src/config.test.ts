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
      importMaxBytes: 32 * 1024 * 1024,
      secretKey: undefined,
      webhookTimeoutMs: 10_000,
      webhookConcurrency: 8,
      webhookPollMs: 1000,
      webhookRetentionDays: 30,
      webhookAllowedTargets: [],
    });
  });

  it('parses the webhook allow-list and rejects entries that are not targets', () => {
    const c = loadConfig({
      FLAGSHIP_DATABASE_URL: url,
      FLAGSHIP_WEBHOOK_ALLOWED_TARGETS: ' 10.0.0.0/8, fd00::/8 ,receiver.internal,, ',
    });
    expect(c.webhookAllowedTargets).toEqual(['10.0.0.0/8', 'fd00::/8', 'receiver.internal']);
    expect(
      loadConfig({ FLAGSHIP_DATABASE_URL: url, FLAGSHIP_WEBHOOK_ALLOWED_TARGETS: '' })
        .webhookAllowedTargets,
    ).toEqual([]);
    expect(() =>
      loadConfig({
        FLAGSHIP_DATABASE_URL: url,
        FLAGSHIP_WEBHOOK_ALLOWED_TARGETS: '10.0.0.0/8,10.0.0.0/99,https://x',
      }),
    ).toThrow(
      'FLAGSHIP_WEBHOOK_ALLOWED_TARGETS: "10.0.0.0/99" is not an IP address, a CIDR range or a host name\n' +
        '  FLAGSHIP_WEBHOOK_ALLOWED_TARGETS: "https://x" is not an IP address, a CIDR range or a host name',
    );
  });

  it('parses the secret key and webhook settings', () => {
    const key = Buffer.alloc(32, 7);
    const c = loadConfig({
      FLAGSHIP_DATABASE_URL: url,
      FLAGSHIP_SECRET_KEY: key.toString('base64'),
      FLAGSHIP_WEBHOOK_TIMEOUT_MS: '5000',
      FLAGSHIP_WEBHOOK_CONCURRENCY: '2',
      FLAGSHIP_WEBHOOK_POLL_MS: '250',
      FLAGSHIP_WEBHOOK_RETENTION_DAYS: '7',
    });
    expect(c.secretKey?.equals(key)).toBe(true);
    expect(c).toMatchObject({
      webhookTimeoutMs: 5000,
      webhookConcurrency: 2,
      webhookPollMs: 250,
      webhookRetentionDays: 7,
    });
    expect(loadConfig({ FLAGSHIP_DATABASE_URL: url, FLAGSHIP_SECRET_KEY: '' }).secretKey).toBe(
      undefined,
    );
    expect(() =>
      loadConfig({ FLAGSHIP_DATABASE_URL: url, FLAGSHIP_SECRET_KEY: 'c2hvcnQ=' }),
    ).toThrow(/FLAGSHIP_SECRET_KEY: must decode to exactly 32 bytes/);
    expect(() =>
      loadConfig({ FLAGSHIP_DATABASE_URL: url, FLAGSHIP_WEBHOOK_TIMEOUT_MS: '60000' }),
    ).toThrow(/FLAGSHIP_WEBHOOK_TIMEOUT_MS/);
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
      FLAGSHIP_ADMIN_UI_DIR: 'admin/dist',
      FLAGSHIP_IMPORT_MAX_MB: '100',
    });
    expect(c).toMatchObject({
      port: 9000,
      trustProxy: true,
      cookieSecure: 'true',
      allowedOrigins: ['https://flags.acme.com', 'http://localhost:5173'],
      bootstrapAdmin: { email: 'admin@acme.com', password: 'correct horse battery' },
      metricsToken: 'a-long-metrics-token',
      adminUiDir: `${process.cwd()}/admin/dist`,
      importMaxBytes: 100 * 1024 * 1024,
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
