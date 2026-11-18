import type { Config } from './config.js';
import type { Db } from './db/database.js';
import type { EgressPolicy } from './egress.js';
import type { Metrics } from './metrics.js';
import type { SecretBox } from './secretbox.js';
import type { KeyAuthenticator } from './services/apikeys.js';

/** What route modules and services need from the app. */
export interface Context {
  config: Config;
  db: Db;
  metrics: Metrics;
  now: () => Date;
  keys: KeyAuthenticator;
  /** Seals secrets stored in the database; undefined without FLAGSHIP_SECRET_KEY. */
  secrets: SecretBox | undefined;
  /** Which addresses outbound requests (webhooks) may connect to. */
  egress: EgressPolicy;
}
