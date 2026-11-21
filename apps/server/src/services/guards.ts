import {
  rolloutPlanSchema,
  sameServe,
  serveAt,
  stepServe,
  withServeAt,
  type RolloutGuard,
  type RolloutPlan,
} from '@flagship/core';
import { relativeLift, summarize, welchTTest, type Interval, type Summary } from '@flagship/stats';
import type { ControlledTransaction } from 'kysely';
import type { Logger } from 'pino';
import type { Db } from '../db/database.js';
import type { Database } from '../db/schema.js';
import { AppError, notFound } from '../errors.js';
import type { Metrics } from '../metrics.js';
import { recordAudit } from './audit.js';
import { rolledUpConversions, type RolledUpVariant, type Slice } from './experimentRollup.js';
import { writeConfig, type Scope } from './flags.js';
import { flagWithConfig } from './rolloutPlans.js';
import { lockEnvironments } from './rulesets.js';

/**
 * Guards are two-sided 99% intervals. They are read again after every rollup
 * that touches the flag, so a single look at 95% would raise false alarms far
 * more often than once in twenty plans; the stricter level, the minimum
 * sample and the threshold together keep a healthy rollout running.
 */
export const GUARD_CONFIDENCE = 0.99;

/**
 * An active guarded plan not checked for this long is checked even when no
 * rollup touched it on this instance: another instance may have rolled up
 * its flag and stopped before checking.
 */
export const GUARD_RECHECK_MS = 15 * 60_000;

/** Plans checked per turn at most. */
const GUARD_BATCH = 200;

export type GuardState = 'waiting' | 'ok' | 'breached';

export interface GuardSide {
  variant: string;
  exposed: number;
  /** Per exposed context: the conversion rate, mean count or mean value; null with no exposures. */
  mean: number | null;
}

/** What one guard sees in the rollup now. */
export interface GuardReading {
  guard: RolloutGuard;
  /** `waiting` until both sides have `minContexts` exposed contexts. */
  state: GuardState;
  variant: GuardSide;
  baseline: GuardSide;
  /** Variant mean / baseline mean − 1; null when the baseline mean is 0 or a side has under two contexts. */
  lift: number | null;
  liftInterval: Interval | null;
  /** Variant mean − baseline mean, with Welch's interval; null when a side has under two contexts. */
  difference: number | null;
  differenceInterval: Interval | null;
  pValue: number | null;
}

/** The values that paused or rolled back a plan, kept on the plan and in the audit log. */
export interface GuardBreach {
  at: string;
  /** The step and weight the plan was on. */
  step: number;
  weight: number;
  action: 'pause' | 'rollback';
  /** False when a rollback guard breached but the serve could not be rolled back, so the plan paused. */
  rolledBack: boolean;
  note: string | null;
  /** Contexts first exposed from this time on were counted. */
  from: string;
  confidence: number;
  readings: GuardReading[];
}

function summaryOf(kind: RolloutGuard['kind'], r: RolledUpVariant | undefined): Summary {
  if (r === undefined) return summarize(0, 0, 0);
  if (kind === 'conversion') return summarize(r.exposed, r.converted, r.converted);
  if (kind === 'count') return summarize(r.exposed, r.conversions, r.conversionSquares);
  return summarize(r.exposed, r.value, r.valueSquares);
}

/**
 * Reads one guard against the rolled-up numbers of the plan's two variants.
 * It breaches only when the variant is worse than the baseline by more than
 * the threshold with 99% confidence: the whole interval for the lift lies
 * past it. When the baseline mean is 0 a relative change is undefined, so a
 * "higher is worse" guard breaches once the difference's interval is above 0
 * (any rise from nothing is past every threshold) and a "lower is worse" one
 * cannot breach. Pure, so it can be checked without a database.
 */
export function readGuard(
  guard: RolloutGuard,
  plan: Pick<RolloutPlan, 'variant' | 'baseline'>,
  rows: readonly RolledUpVariant[],
): GuardReading {
  const v = rows.find((r) => r.variant === plan.variant);
  const b = rows.find((r) => r.variant === plan.baseline);
  const sv = summaryOf(guard.kind, v);
  const sb = summaryOf(guard.kind, b);
  const welch = welchTTest(sb, sv, { confidence: GUARD_CONFIDENCE });
  const lift = relativeLift(sb, sv, { confidence: GUARD_CONFIDENCE });
  const reading: GuardReading = {
    guard,
    state: 'ok',
    variant: { variant: plan.variant, exposed: sv.n, mean: sv.n === 0 ? null : sv.mean },
    baseline: { variant: plan.baseline, exposed: sb.n, mean: sb.n === 0 ? null : sb.mean },
    lift: lift?.lift ?? null,
    liftInterval: lift?.interval ?? null,
    difference: welch?.difference ?? null,
    differenceInterval: welch?.interval ?? null,
    pValue: welch?.pValue ?? null,
  };
  if (sv.n < guard.minContexts || sb.n < guard.minContexts) {
    return { ...reading, state: 'waiting' };
  }
  let breached = false;
  if (lift !== null) {
    breached =
      guard.worse === 'higher'
        ? lift.interval.lower > guard.threshold
        : lift.interval.upper < -guard.threshold;
  } else if (guard.worse === 'higher' && welch !== null) {
    breached = welch.interval.lower > 0;
  }
  return { ...reading, state: breached ? 'breached' : 'ok' };
}

/** Reads every guard of a plan against the rollup, for contexts first exposed from `from`. */
export async function readGuards(
  db: Db,
  q: { environmentId: string; flag: string; plan: RolloutPlan; from: Date },
): Promise<GuardReading[]> {
  const readings: GuardReading[] = [];
  const byEvent = new Map<string, RolledUpVariant[]>();
  for (const guard of q.plan.guards ?? []) {
    let rows = byEvent.get(guard.event);
    if (rows === undefined) {
      rows = await rolledUpConversions(db, {
        environmentId: q.environmentId,
        flag: q.flag,
        event: guard.event,
        from: q.from,
      });
      byEvent.set(guard.event, rows);
    }
    readings.push(readGuard(guard, q.plan, rows));
  }
  return readings;
}

export interface PlanGuardsView {
  plan: string;
  /** Contexts first exposed from this time on are counted. */
  from: string;
  confidence: number;
  readings: GuardReading[];
}

/** What each guard of a plan reads now, whatever the plan's status. */
export async function planGuards(
  db: Db,
  projectId: string,
  environmentId: string,
  key: string,
  id: string,
): Promise<PlanGuardsView> {
  const flag = await flagWithConfig(db, projectId, environmentId, key);
  const row = await db
    .selectFrom('rollout_plans')
    .select(['id', 'plan', 'guard_from'])
    .where('id', '=', id)
    .where('flag_id', '=', flag.id)
    .where('environment_id', '=', environmentId)
    .executeTakeFirst();
  if (row === undefined) throw notFound('rollout plan');
  const parsed = rolloutPlanSchema.safeParse(row.plan);
  const readings = parsed.success
    ? await readGuards(db, { environmentId, flag: key, plan: parsed.data, from: row.guard_from })
    : [];
  return {
    plan: row.id,
    from: row.guard_from.toISOString(),
    confidence: GUARD_CONFIDENCE,
    readings,
  };
}

export type GuardResult = 'ok' | 'paused' | 'rolled_back' | 'skipped';

/**
 * Checks one guarded plan, in one transaction. The plan row is claimed with
 * FOR UPDATE SKIP LOCKED before the environment lock, the order the scheduler
 * and the pause, resume and cancel routes take them in; a plan someone else
 * holds is skipped and checked on a later turn. A breach pauses the plan, or,
 * when a breached guard says so, writes the baseline to the targeted serve
 * through the normal write path (validated, versioned, published to SDKs and
 * audited like any edit) and ends the plan as rolled back. A rollback never
 * overwrites a serve that was edited by hand since the step: the plan pauses
 * instead and says why. Either way the readings go into the audit log.
 */
export async function checkPlanGuards(
  db: Db,
  id: string,
  o: { retention: number; now: Date },
): Promise<GuardResult> {
  const trx = await db.startTransaction().execute();
  try {
    const result = await checkInTransaction(trx, id, o);
    await trx.commit().execute();
    return result;
  } catch (err) {
    await trx.rollback().execute();
    throw err;
  }
}

async function checkInTransaction(
  trx: ControlledTransaction<Database>,
  id: string,
  o: { retention: number; now: Date },
): Promise<GuardResult> {
  const row = await trx
    .selectFrom('rollout_plans')
    .innerJoin('flags', 'flags.id', 'rollout_plans.flag_id')
    .innerJoin('environments', 'environments.id', 'rollout_plans.environment_id')
    .innerJoin('projects', 'projects.id', 'flags.project_id')
    .select([
      'rollout_plans.id',
      'rollout_plans.plan',
      'rollout_plans.step',
      'rollout_plans.guard_from',
      'rollout_plans.created_by_name',
      'flags.key as flag_key',
      'environments.id as environment_id',
      'environments.key as environment_key',
      'projects.id as project_id',
      'projects.key as project_key',
      'projects.name as project_name',
    ])
    .where('rollout_plans.id', '=', id)
    .where('rollout_plans.status', '=', 'active')
    .forUpdate('rollout_plans')
    .skipLocked()
    .executeTakeFirst();
  if (row === undefined) return 'skipped';
  const markChecked = (extra: Record<string, unknown> = {}) =>
    trx
      .updateTable('rollout_plans')
      .set({ guard_checked_at: o.now, ...extra })
      .where('id', '=', row.id)
      .execute();
  const parsed = rolloutPlanSchema.safeParse(row.plan);
  // A plan that no longer parses is failed by the scheduler on its next step.
  if (!parsed.success || (parsed.data.guards ?? []).length === 0) {
    await markChecked();
    return 'ok';
  }
  const plan = parsed.data;
  const readings = await readGuards(trx, {
    environmentId: row.environment_id,
    flag: row.flag_key,
    plan,
    from: row.guard_from,
  });
  const breached = readings.filter((r) => r.state === 'breached');
  if (breached.length === 0) {
    await markChecked();
    return 'ok';
  }

  const env = { id: row.environment_id, key: row.environment_key };
  await lockEnvironments(trx, [env.id]);
  const flag = await flagWithConfig(trx, row.project_id, env.id, row.flag_key);
  if (flag.archived_at !== null) {
    // Archiving cancels the plan; the scheduler finishes one it skipped.
    await markChecked();
    return 'skipped';
  }
  const wantsRollback = breached.some((r) => r.guard.action === 'rollback');
  let rolledBack = false;
  let note: string | null = null;
  const scope: Scope = {
    db: trx,
    project: { id: row.project_id, key: row.project_key, name: row.project_name },
    actor: { id: null, name: `Rollout guard on a plan by ${row.created_by_name}` },
    retention: o.retention,
  };
  if (wantsRollback) {
    const serve = serveAt(flag, plan.target);
    if (serve === undefined || !sameServe(serve, stepServe(plan, row.step))) {
      note = 'the targeted serve was edited after the step, so it was left alone';
    } else {
      const sp = await trx.savepoint('rollback').execute();
      try {
        await writeConfig(
          sp,
          scope,
          env,
          row.flag_key,
          (c) => ({ ...c, ...withServeAt(c, plan.target, { variant: plan.baseline }) }),
          undefined,
          'flag.rollout.rollback',
        );
        await sp.releaseSavepoint('rollback').execute();
        rolledBack = true;
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        await sp.rollbackToSavepoint('rollback').execute();
        note = `the rollback was refused: ${err.message}`.slice(0, 500);
      }
    }
  }
  const breach: GuardBreach = {
    at: o.now.toISOString(),
    step: row.step,
    weight: plan.steps[row.step]?.weight ?? 0,
    action: wantsRollback ? 'rollback' : 'pause',
    rolledBack,
    note,
    from: row.guard_from.toISOString(),
    confidence: GUARD_CONFIDENCE,
    readings: breached,
  };
  await trx
    .updateTable('rollout_plans')
    .set({
      status: rolledBack ? 'rolled_back' : 'paused',
      paused_reason: rolledBack ? null : 'guard',
      next_at: null,
      ...(rolledBack ? { finished_at: o.now } : {}),
      guard_checked_at: o.now,
      guard_breach: JSON.stringify(breach),
      updated_at: o.now,
    })
    .where('id', '=', row.id)
    .execute();
  await recordAudit(trx, {
    projectId: row.project_id,
    environmentId: env.id,
    actor: scope.actor,
    action: 'flag.rollout.guard',
    targetType: 'flag',
    targetKey: row.flag_key,
    after: { plan: row.id, ...breach },
  });
  return rolledBack ? 'rolled_back' : 'paused';
}

/**
 * The housekeeping step that runs after each rollup turn: checks the active
 * guarded plans whose flag the turn rolled up, and any not checked for
 * GUARD_RECHECK_MS. One plan failing is logged and does not stop the rest.
 */
export function rolloutGuards(o: {
  db: Db;
  metrics: Metrics;
  logger: Logger;
  retention: number;
}): (slices: readonly Slice[], now: Date) => Promise<number> {
  return async (slices, now) => {
    const touched = new Map<string, Slice>();
    for (const s of slices) touched.set(`${s.environmentId}|${s.flag}`, s);
    const stale = new Date(now.getTime() - GUARD_RECHECK_MS);
    const due = await o.db
      .selectFrom('rollout_plans')
      .innerJoin('flags', 'flags.id', 'rollout_plans.flag_id')
      .select('rollout_plans.id')
      .where('rollout_plans.status', '=', 'active')
      .where((eb) =>
        eb.and([
          eb(eb.ref('rollout_plans.plan'), '?', 'guards'),
          eb.or([
            eb('rollout_plans.guard_checked_at', 'is', null),
            eb('rollout_plans.guard_checked_at', '<', stale),
            ...[...touched.values()].map((s) =>
              eb.and([
                eb('rollout_plans.environment_id', '=', s.environmentId),
                eb('flags.key', '=', s.flag),
              ]),
            ),
          ]),
        ]),
      )
      .orderBy('rollout_plans.guard_checked_at', (b) => b.asc().nullsFirst())
      .limit(GUARD_BATCH)
      .execute();
    let acted = 0;
    for (const { id } of due) {
      try {
        const result = await checkPlanGuards(o.db, id, { retention: o.retention, now });
        o.metrics.rolloutGuardChecks.inc({ result });
        if (result === 'paused' || result === 'rolled_back') acted++;
      } catch (err) {
        o.metrics.rolloutGuardChecks.inc({ result: 'error' });
        o.logger.error({ err, plan: id }, 'rollout guard check failed');
      }
    }
    return acted;
  };
}
