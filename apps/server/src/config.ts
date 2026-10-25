import { resolve } from 'node:path';
import { z } from 'zod';

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
    FLAGSHIP_CHANGE_RETENTION: int(10, 1_000_000, 1000),
    FLAGSHIP_ADMIN_UI_DIR: z.string().min(1).optional(),
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
  changeRetention: number;
  adminUiDir: string | undefined;
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
    changeRetention: c.FLAGSHIP_CHANGE_RETENTION,
    adminUiDir:
      c.FLAGSHIP_ADMIN_UI_DIR === undefined ? undefined : resolve(c.FLAGSHIP_ADMIN_UI_DIR),
  };
}
