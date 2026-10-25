import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { createDatabase, migrate } from './db/database.js';
import { createLogger } from './log.js';

/**
 * flagship server.
 *
 * Configuration comes from environment variables:
 *
 *   FLAGSHIP_DATABASE_URL          postgres://user:pass@host/db (required)
 *   FLAGSHIP_DB_POOL_SIZE          connection pool size (20)
 *   FLAGSHIP_HOST, FLAGSHIP_PORT   listen address (0.0.0.0, 8080)
 *   FLAGSHIP_LOG_LEVEL             fatal|error|warn|info|debug|trace (info)
 *   FLAGSHIP_TRUST_PROXY           trust X-Forwarded-* from a proxy in front (false)
 *   FLAGSHIP_COOKIE_SECURE         auto|true|false; auto marks the session cookie Secure on HTTPS requests (auto)
 *   FLAGSHIP_ALLOWED_ORIGINS       extra origins allowed to call the admin API, comma separated
 *   FLAGSHIP_ADMIN_EMAIL           first admin, created only when there are no users yet
 *   FLAGSHIP_ADMIN_PASSWORD        password for that admin, at least 12 characters
 *   FLAGSHIP_METRICS_TOKEN         bearer token for /metrics; without it /metrics answers loopback only
 *   FLAGSHIP_SESSION_IDLE_MINUTES  sign out after this much inactivity (720)
 *   FLAGSHIP_SESSION_MAX_HOURS     sign out after this long regardless (168)
 *   FLAGSHIP_MAX_STREAMS           open SSE connections per server (20000)
 *   FLAGSHIP_MAX_STREAMS_PER_KEY   open SSE connections per server key (1000)
 *   FLAGSHIP_HEARTBEAT_SECONDS     SSE heartbeat interval (15)
 *   FLAGSHIP_SCHEDULER_INTERVAL_MS how often due scheduled changes are applied (5000)
 *   FLAGSHIP_EVENTS_FLUSH_MS       how often exposure counts are written (2000)
 *   FLAGSHIP_EVENTS_QUEUE_LIMIT    distinct exposure rows held before answering 429 (50000)
 *   FLAGSHIP_CHANGE_RETENTION      ruleset changes kept per environment for stream resume (1000)
 *   FLAGSHIP_ADMIN_UI_DIR          directory of the built admin UI to serve at /
 */
async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }

  const logger = createLogger(config.logLevel);
  const { db } = createDatabase({ url: config.databaseUrl, maxConnections: config.dbPoolSize });
  await migrate(db);
  const app = await buildApp({ config, db, logger });
  await app.server.listen({ host: config.host, port: config.port });

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => {
      logger.error('shutdown took longer than 10s, exiting');
      process.exit(1);
    }, 10_000);
    force.unref();
    app
      .close()
      .then(() => db.destroy())
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        logger.error({ err }, 'error during shutdown');
        process.exit(1);
      });
  };
  process.on('SIGTERM', () => {
    stop('SIGTERM');
  });
  process.on('SIGINT', () => {
    stop('SIGINT');
  });
}

main().catch((err: unknown) => {
  process.stderr.write(
    `fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
