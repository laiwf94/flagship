import { resolve } from 'node:path';
import { z } from 'zod';
import { parseAllowEntry } from './egress.js';
import { parseSecretKey, SecretKeyError } from './secretbox.js';

const flag = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const int = (min: number, max: number, fallback: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const schema = z
  .object({
    FLAGSHIP_DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL'),
    FLAGSHIP_DB_POOL_SIZE: int(2, 200, 20),
    FLAGSHIP_HOST: z.string().min(1).default('0.0.0.0'),
    FLAGSHIP_PORT: int(0, 65_535, 8080),
    FLAGSHIP_LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
      .default('info'),
    FLAGSHIP_TRUST_PROXY: flag.default(false),
    FLAGSHIP_COOKIE_SECURE: z.enum(['auto', 'true', 'false']).default('auto'),
    FLAGSHIP_ALLOWED_ORIGINS: z
      .string()
      .optional()
      .transform((v) => (v === undefined || v === '' ? [] : v.split(',').map((s) => s.trim())))
      .pipe(z.array(z.url())),
    FLAGSHIP_ADMIN_EMAIL: z.email().optional(),
    FLAGSHIP_ADMIN_PASSWORD: z.string().min(12, 'must be at least 12 characters').optional(),
    FLAGSHIP_METRICS_TOKEN: z.string().min(16, 'must be at least 16 characters').optional(),
    FLAGSHIP_SESSION_IDLE_MINUTES: int(5, 10_080, 720),
    FLAGSHIP_SESSION_MAX_HOURS: int(1, 2160, 168),
    FLAGSHIP_MAX_STREAMS: int(1, 1_000_000, 20_000),
    FLAGSHIP_MAX_STREAMS_PER_KEY: int(1, 1_000_000, 1000),
    FLAGSHIP_HEARTBEAT_SECONDS: int(1, 300, 15),
    FLAGSHIP_SCHEDULER_INTERVAL_MS: int(100, 3_600_000, 5000),
    FLAGSHIP_EVENTS_FLUSH_MS: int(50, 60_000, 2000),
    FLAGSHIP_EVENTS_QUEUE_LIMIT: int(1, 10_000_000, 50_000),
    FLAGSHIP_ROLLUP_INTERVAL_MS: int(1000, 3_600_000, 60_000),
    FLAGSHIP_CHANGE_RETENTION: int(10, 1_000_000, 1000),
    FLAGSHIP_IMPORT_MAX_MB: int(1, 1024, 32),
    FLAGSHIP_ADMIN_UI_DIR: z.string().min(1).optional(),
    FLAGSHIP_SECRET_KEY: z
      .string()
      .optional()
      .transform((v, ctx) => {
        if (v === undefined || v === '') return undefined;
        try {
          return parseSecretKey(v);
        } catch (err) {
          if (!(err instanceof SecretKeyError)) throw err;
          ctx.addIssue({ code: 'custom', message: err.message });
          return z.NEVER;
        }
      }),
    FLAGSHIP_WEBHOOK_TIMEOUT_MS: int(1000, 30_000, 10_000),
    FLAGSHIP_WEBHOOK_CONCURRENCY: int(1, 100, 8),
    FLAGSHIP_WEBHOOK_POLL_MS: int(100, 60_000, 1000),
    FLAGSHIP_WEBHOOK_RETENTION_DAYS: int(1, 365, 30),
    FLAGSHIP_WEBHOOK_ALLOWED_TARGETS: z
      .string()
      .optional()
      .transform((v, ctx) => {
        const list = (v ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s !== '');
        for (const entry of list) {
          if (parseAllowEntry(entry) === null) {
            ctx.addIssue({
              code: 'custom',
              message: `"${entry}" is not an IP address, a CIDR range or a host name`,
            });
          }
        }
        return list;
      }),
  })
  .refine(
    (c) => (c.FLAGSHIP_ADMIN_EMAIL === undefined) === (c.FLAGSHIP_ADMIN_PASSWORD === undefined),
    {
      message: 'set both FLAGSHIP_ADMIN_EMAIL and FLAGSHIP_ADMIN_PASSWORD, or neither',
      path: ['FLAGSHIP_ADMIN_EMAIL'],
    },
  );

export interface Config {
  databaseUrl: string;
  dbPoolSize: number;
  host: string;
  port: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  trustProxy: boolean;
  cookieSecure: 'auto' | 'true' | 'false';
  allowedOrigins: string[];
  bootstrapAdmin: { email: string; password: string } | undefined;
  metricsToken: string | undefined;
  sessionIdleMinutes: number;
  sessionMaxHours: number;
  maxStreams: number;
  maxStreamsPerKey: number;
  heartbeatSeconds: number;
  schedulerIntervalMs: number;
  eventsFlushMs: number;
  eventsQueueLimit: number;
  /** How often experiment results are rolled up from new events. */
  rollupIntervalMs: number;
  changeRetention: number;
  /** Largest project import accepted, in bytes. */
  importMaxBytes: number;
  adminUiDir: string | undefined;
  /** Encrypts secrets at rest, such as webhook signing secrets; webhooks need it. */
  secretKey: Buffer | undefined;
  /** Deadline for one webhook delivery attempt: connect, send and read the response. */
  webhookTimeoutMs: number;
  /** Webhook deliveries in flight at once on each instance. */
  webhookConcurrency: number;
  /** Fallback poll for due webhook deliveries; new ones wake the worker at once. */
  webhookPollMs: number;
  /** How long finished webhook deliveries are kept. */
  webhookRetentionDays: number;
  /**
   * Private, loopback or link-local webhook receivers let through anyway:
   * addresses, CIDR ranges or exact host names.
   */
  webhookAllowedTargets: string[];
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid configuration:\n  ${problems.join('\n  ')}`);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const c = parsed.data;
  return {
    databaseUrl: c.FLAGSHIP_DATABASE_URL,
    dbPoolSize: c.FLAGSHIP_DB_POOL_SIZE,
    host: c.FLAGSHIP_HOST,
    port: c.FLAGSHIP_PORT,
    logLevel: c.FLAGSHIP_LOG_LEVEL,
    trustProxy: c.FLAGSHIP_TRUST_PROXY,
    cookieSecure: c.FLAGSHIP_COOKIE_SECURE,
    allowedOrigins: c.FLAGSHIP_ALLOWED_ORIGINS.map((o) => new URL(o).origin),
    bootstrapAdmin:
      c.FLAGSHIP_ADMIN_EMAIL !== undefined && c.FLAGSHIP_ADMIN_PASSWORD !== undefined
        ? { email: c.FLAGSHIP_ADMIN_EMAIL.toLowerCase(), password: c.FLAGSHIP_ADMIN_PASSWORD }
        : undefined,
    metricsToken: c.FLAGSHIP_METRICS_TOKEN,
    sessionIdleMinutes: c.FLAGSHIP_SESSION_IDLE_MINUTES,
    sessionMaxHours: c.FLAGSHIP_SESSION_MAX_HOURS,
    maxStreams: c.FLAGSHIP_MAX_STREAMS,
    maxStreamsPerKey: c.FLAGSHIP_MAX_STREAMS_PER_KEY,
    heartbeatSeconds: c.FLAGSHIP_HEARTBEAT_SECONDS,
    schedulerIntervalMs: c.FLAGSHIP_SCHEDULER_INTERVAL_MS,
    eventsFlushMs: c.FLAGSHIP_EVENTS_FLUSH_MS,
    eventsQueueLimit: c.FLAGSHIP_EVENTS_QUEUE_LIMIT,
    rollupIntervalMs: c.FLAGSHIP_ROLLUP_INTERVAL_MS,
    changeRetention: c.FLAGSHIP_CHANGE_RETENTION,
    importMaxBytes: c.FLAGSHIP_IMPORT_MAX_MB * 1024 * 1024,
    adminUiDir:
      c.FLAGSHIP_ADMIN_UI_DIR === undefined ? undefined : resolve(c.FLAGSHIP_ADMIN_UI_DIR),
    secretKey: c.FLAGSHIP_SECRET_KEY,
    webhookTimeoutMs: c.FLAGSHIP_WEBHOOK_TIMEOUT_MS,
    webhookConcurrency: c.FLAGSHIP_WEBHOOK_CONCURRENCY,
    webhookPollMs: c.FLAGSHIP_WEBHOOK_POLL_MS,
    webhookRetentionDays: c.FLAGSHIP_WEBHOOK_RETENTION_DAYS,
    webhookAllowedTargets: c.FLAGSHIP_WEBHOOK_ALLOWED_TARGETS,
  };
}
