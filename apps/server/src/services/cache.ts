import type { Ruleset } from '@flagship/core';
import type { Db } from '../db/database.js';
import type { Metrics } from '../metrics.js';
import { loadRuleset } from './rulesets.js';

export interface Snapshot {
  ruleset: Ruleset;
  version: number;
  json: string;
  etag: string;
}

/**
 * Serialised rulesets per environment, shared by every request on this
 * instance. Entries are dropped when a NOTIFY says the environment changed;
 * the TTL only matters if a notification is ever lost (the listener
 * reconnecting, for instance), so it bounds staleness rather than driving it.
 */
export class RulesetCache {
  private readonly entries = new Map<string, { snapshot: Snapshot; loadedAt: number }>();
  private readonly loading = new Map<string, Promise<Snapshot>>();
  private generation = 0;

  constructor(
    private readonly db: Db,
    private readonly metrics: Metrics,
    private readonly ttlMs = 30_000,
  ) {}

  async get(environmentId: string): Promise<Snapshot> {
    const hit = this.entries.get(environmentId);
    if (hit !== undefined && Date.now() - hit.loadedAt < this.ttlMs) return hit.snapshot;
    let pending = this.loading.get(environmentId);
    if (pending === undefined) {
      pending = this.load(environmentId).finally(() => this.loading.delete(environmentId));
      this.loading.set(environmentId, pending);
    }
    return pending;
  }

  private async load(environmentId: string): Promise<Snapshot> {
    const generation = this.generation;
    // One snapshot: flags, segments and the version must agree with each other.
    const ruleset = await this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute((trx) => loadRuleset(trx, environmentId));
    this.metrics.rulesetBuilds.inc();
    const snapshot: Snapshot = {
      ruleset,
      version: ruleset.version,
      json: JSON.stringify(ruleset),
      etag: `"${environmentId.slice(0, 8)}-${ruleset.version}"`,
    };
    // An invalidation that raced this load must win; don't cache what may be stale.
    if (generation === this.generation) {
      this.entries.set(environmentId, { snapshot, loadedAt: Date.now() });
    }
    return snapshot;
  }

  invalidate(environmentId?: string): void {
    this.generation++;
    if (environmentId === undefined) this.entries.clear();
    else this.entries.delete(environmentId);
  }
}
