import { lifecycleOf, LIFECYCLE_STAGES, type Lifecycle, type LifecycleStage } from '@flagship/core';
import { sql } from 'kysely';
import type { Logger } from 'pino';
import type { Db } from '../db/database.js';
import type { Metrics } from '../metrics.js';
import { recordAudit, type Actor } from './audit.js';
import type { ConfigRow } from './rulesets.js';

/** The columns stale detection needs, as selected next to a flag's targeting. */
export interface LifecycleColumns extends Pick<
  ConfigRow,
  'enabled' | 'off_variant' | 'prerequisites' | 'rules' | 'fallthrough'
> {
  archived_at: Date | null;
  created_at: Date;
  targeting_changed_at: Date;
  last_evaluated_at: Date | null;
}

const HOUR = 3_600_000;

export function lifecycleFromRow(r: LifecycleColumns, now: Date): Lifecycle {
  return lifecycleOf({
    config: {
      enabled: r.enabled,
      offVariant: r.off_variant,
      prerequisites: r.prerequisites,
      rules: r.rules,
      fallthrough: r.fallthrough,
    },
    archived: r.archived_at !== null,
    createdAt: r.created_at.getTime(),
    targetingChangedAt: r.targeting_changed_at.getTime(),
    lastEvaluatedAt: r.last_evaluated_at?.getTime() ?? null,
    now: now.getTime(),
    // Evaluations are kept by the hour they fell in.
    evaluationResolutionMs: HOUR,
  });
}

/** Flags joined with their targeting in one environment and when they were last evaluated there. */
export function lifecycleQuery(db: Db) {
  return db
    .selectFrom('flags')
    .innerJoin('flag_configs', 'flag_configs.flag_id', 'flags.id')
    .leftJoin('flag_evaluations', (j) =>
      j
        .onRef('flag_evaluations.environment_id', '=', 'flag_configs.environment_id')
        .onRef('flag_evaluations.flag_key', '=', 'flags.key'),
    )
    .select([
      'flag_configs.enabled',
      'flag_configs.off_variant',
      'flag_configs.prerequisites',
      'flag_configs.rules',
      'flag_configs.fallthrough',
      'flags.archived_at',
      'flags.created_at',
      'flag_configs.updated_at as targeting_changed_at',
      'flag_evaluations.last_evaluated_at',
    ]);
}

export interface StaleFlag {
  key: string;
  name: string;
  stage: LifecycleStage;
  reasons: Lifecycle['reasons'];
  lastEvaluatedAt: string | null;
  targetingChangedAt: string;
}

/**
 * Every unarchived flag that is stale in the environment, longest stale
 * first: the cleanup list. It reads at most one row per flag (5,000 per
 * ruleset) and is classified in memory, so it is always current.
 */
export async function staleFlags(
  db: Db,
  projectId: string,
  environmentId: string,
  now: Date,
): Promise<StaleFlag[]> {
  const rows = await lifecycleQuery(db)
    .select(['flags.key', 'flags.name'])
    .where('flags.project_id', '=', projectId)
    .where('flag_configs.environment_id', '=', environmentId)
    .where('flags.archived_at', 'is', null)
    .execute();
  const out: { flag: StaleFlag; oldest: string }[] = [];
  for (const r of rows) {
    const life = lifecycleFromRow(r, now);
    if (!life.stale) continue;
    out.push({
      flag: {
        key: r.key,
        name: r.name,
        stage: life.stage,
        reasons: life.reasons,
        lastEvaluatedAt: r.last_evaluated_at?.toISOString() ?? null,
        targetingChangedAt: r.targeting_changed_at.toISOString(),
      },
      oldest: life.reasons.map((x) => x.since).sort()[0] ?? '',
    });
  }
  out.sort((a, b) =>
    a.oldest !== b.oldest ? (a.oldest < b.oldest ? -1 : 1) : a.flag.key < b.flag.key ? -1 : 1,
  );
  return out.map((x) => x.flag);
}

const STALE: ReadonlySet<LifecycleStage> = new Set(['launched', 'inactive']);

/**
 * Whether a change of stage is worth a History entry: becoming stale, or
 * stopping being stale for a reason other than being archived (archiving has
 * its own entry). The first check of a flag that isn't stale is silent.
 */
export function isNotableTransition(before: LifecycleStage | null, after: LifecycleStage): boolean {
  if (before === after) return false;
  if (STALE.has(after)) return true;
  return before !== null && STALE.has(before) && after !== 'archived';
}

export interface LifecycleCheckOptions {
  db: Db;
  metrics: Metrics;
  logger: Logger;
  /** How long a stored stage is good for before the row is checked again. */
  recheckMs?: number;
  /** Rows per transaction. */
  batch?: number;
  /** Transactions per run, so one run stays bounded. */
  maxBatches?: number;
}

const ACTOR: Actor = { id: null, name: 'Lifecycle check' };

/**
 * The nightly lifecycle check. Each run claims flag targeting rows not
 * checked within `recheckMs` with FOR UPDATE SKIP LOCKED, so instances share
 * the work and a row is checked by one of them, classifies each, stores the
 * stage, and records a `flag.lifecycle` audit entry when a flag becomes
 * stale or stops being stale. Then it publishes the count per stage.
 * Returns how many rows changed stage.
 */
export function lifecycleCheck(o: LifecycleCheckOptions) {
  const recheckMs = o.recheckMs ?? 24 * 3_600_000;
  const batch = o.batch ?? 500;
  const maxBatches = o.maxBatches ?? 20;

  async function checkBatch(now: Date): Promise<{ checked: number; changed: number }> {
    return o.db.transaction().execute(async (trx) => {
      const rows = await lifecycleQuery(trx)
        .select([
          'flags.key',
          'flags.project_id',
          'flag_configs.flag_id',
          'flag_configs.environment_id',
          'flag_configs.lifecycle_stage',
        ])
        .where((eb) =>
          eb.or([
            eb('flag_configs.lifecycle_checked_at', 'is', null),
            eb('flag_configs.lifecycle_checked_at', '<=', new Date(now.getTime() - recheckMs)),
          ]),
        )
        .orderBy(sql`flag_configs.lifecycle_checked_at NULLS FIRST`)
        .limit(batch)
        .forUpdate('flag_configs')
        .skipLocked()
        .execute();
      let changed = 0;
      for (const r of rows) {
        const life = lifecycleFromRow(r, now);
        const before = r.lifecycle_stage;
        if (before !== life.stage) changed++;
        await trx
          .updateTable('flag_configs')
          .set({ lifecycle_stage: life.stage, lifecycle_checked_at: now })
          .where('flag_id', '=', r.flag_id)
          .where('environment_id', '=', r.environment_id)
          .execute();
        if (isNotableTransition(before, life.stage)) {
          await recordAudit(trx, {
            projectId: r.project_id,
            environmentId: r.environment_id,
            actor: ACTOR,
            action: 'flag.lifecycle',
            targetType: 'flag',
            targetKey: r.key,
            before: { stage: before },
            after: { stage: life.stage, reasons: life.reasons },
          });
          o.metrics.lifecycleTransitions.inc({ stage: life.stage });
        }
      }
      return { checked: rows.length, changed };
    });
  }

  async function publish(): Promise<void> {
    const counts = await o.db
      .selectFrom('flag_configs')
      .select(['lifecycle_stage', sql<string>`count(*)`.as('n')])
      .where('lifecycle_stage', 'is not', null)
      .groupBy('lifecycle_stage')
      .execute();
    const by = new Map(counts.map((c) => [c.lifecycle_stage, Number(c.n)]));
    for (const stage of LIFECYCLE_STAGES) {
      o.metrics.flagsByLifecycle.set(by.get(stage) ?? 0, { stage });
    }
  }

  return async (now: Date): Promise<number> => {
    let changed = 0;
    let checked = 0;
    for (let i = 0; i < maxBatches; i++) {
      const r = await checkBatch(now);
      changed += r.changed;
      checked += r.checked;
      if (r.checked < batch) break;
    }
    await publish();
    if (checked > 0) o.logger.info({ checked, changed }, 'lifecycle check');
    return changed;
  };
}
