import type { Logger } from 'pino';
import { buildApp, type App } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { createDatabase, migrate, type Db } from '../src/db/database.js';
import { createLogger } from '../src/log.js';
import { createTestDatabase } from './db.js';

export interface TestApp {
  app: App;
  db: Db;
  url: string;
  config: Config;
  logs: string[];
  logger: Logger;
  close: () => Promise<void>;
}

/** A migrated database of its own and an app on top of it, with captured logs. */
export async function testApp(
  overrides: Partial<Config> = {},
  extra: { now?: () => Date } = {},
): Promise<TestApp> {
  const { url, drop } = await createTestDatabase();
  const { db } = createDatabase({ url, maxConnections: 10 });
  await migrate(db);
  const logs: string[] = [];
  const logger = createLogger('info', {
    write: (line: string) => {
      logs.push(line);
    },
  });
  const config = { ...loadConfig({ FLAGSHIP_DATABASE_URL: url }), ...overrides };
  const app = await buildApp({ config, db, logger, ...(extra.now ? { now: extra.now } : {}) });
  return {
    app,
    db,
    url,
    config,
    logs,
    logger,
    close: async () => {
      await app.close();
      await db.destroy();
      await drop();
    },
  };
}
