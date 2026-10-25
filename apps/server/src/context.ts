import type { Config } from './config.js';
import type { Db } from './db/database.js';
import type { Metrics } from './metrics.js';

/** What route modules and services need from the app. */
export interface Context {
  config: Config;
  db: Db;
  metrics: Metrics;
  now: () => Date;
}
