import {
  rolloutPlanIssues,
  rolloutPlanSchema,
  sameServe,
  serveAt,
  stepServe,
  withServeAt,
  type RolloutPlan,
} from '@flagship/core';
import type { ControlledTransaction } from 'kysely';
import type { Db } from '../db/database.js';
import type { Database, PausedReason, RolloutStatus } from '../db/schema.js';
import { AppError, notFound } from '../errors.js';
import { recordAudit } from './audit.js';
import { requireNote, requireUnprotected, writeConfig, type Scope } from './flags.js';
import { lockEnvironments } from './rulesets.js';

export interface RolloutPlanView {
  id: string;
  plan: RolloutPlan;
  status: RolloutStatus;
  /** Index of the step applied last. */
  step: number;
  /** Share of contexts the applied step gives the variant, out of ROLLOUT_TOTAL. */
  weight: number;
  /** When the next step is due; set only while the plan is active. */
  nextAt: string | null;
  pausedReason: PausedReason | null;
  error: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

const columns = [
  'id',
  'flag_id',
  'environment_id',
  'plan',
  'status',
  'step',
  'next_at',
  'paused_reason',
  'error',
  'created_by_name',
  'created_at',
  'updated_at',
  'finished_at',
] as const;

interface PlanRow {
  id: string;
  flag_id: string;
  environment_id: string;
  plan: unknown;
  status: RolloutStatus;
  step: number;
  next_at: Date | null;
  paused_reason: PausedReason | null;
  error: string | null;
  created_by_name: string;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}

function view(r: PlanRow): RolloutPlanView {
  const plan = r.plan as RolloutPlan;
  return {
    id: r.id,
    plan,
    status: r.status,
    step: r.step,
    weight: plan.steps[r.step]?.weight ?? 0,
    nextAt: r.next_at?.toISOString() ?? null,
    pausedReason: r.paused_reason,
    error: r.error,
    createdBy: r.created_by_name,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    finishedAt: r.finished_at?.toISOString() ?? null,
  };
}

/** When the step after `step` is due, or null when `step` is the last. */
function nextDue(plan: RolloutPlan, step: number, now: Date): Date | null {
  if (step >= plan.steps.length - 1) return null;
  const hold = plan.steps[step]?.holdMinutes ?? 0;
  return new Date(now.getTime() + hold * 60_000);
}

async function flagWithConfig(db: Db, projectId: string, environmentId: string, key: string) {
  const row = await db
    .selectFrom('flags')
    .innerJoin('flag_configs', 'flag_configs.flag_id', 'flags.id')
    .select([
      'flags.id',
      'flags.key',
      'flags.variants',
      'flags.archived_at',
      'flag_configs.enabled',
      'flag_configs.rules',
      'flag_configs.fallthrough',
    ])
    .where('flags.project_id', '=', projectId)
    .where('flags.key', '=', key)
    .where('flag_configs.environment_id', '=', environmentId)
    .executeTakeFirst();
  if (row === undefined) throw notFound(`flag "${key}"`);
  return row;
}

/** The serve a step writes, applied to the targeting; throws when the targeted rule is gone. */
function applyStep(
  config: Parameters<typeof withServeAt>[0],
  plan: RolloutPlan,
  step: number,
): Parameters<typeof withServeAt>[0] {
  const next = withServeAt(config, plan.target, stepServe(plan, step));
  if (next === undefined) {
    const rule = typeof plan.target === 'object' ? plan.target.rule : '';
    throw new AppError('invalid_argument', `rule "${rule}" no longer exists`);
  }
  return next;
}

export async function listRolloutPlans(
  db: Db,
  projectId: string,
  environmentId: string,
  key: string,
): Promise<RolloutPlanView[]> {
  const flag = await flagWithConfig(db, projectId, environmentId, key);
  const rows = await db
    .selectFrom('rollout_plans')
    .select(columns)
    .where('flag_id', '=', flag.id)
    .where('environment_id', '=', environmentId)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(20)
    .execute();
  return rows.map(view);
}

/**
 * Starts a plan and applies its first step in the same transaction, so the
 * response already shows it live. Like scheduled changes, plans run without
 * review and so are refused in protected environments.
 */
export async function startRolloutPlan(
  scope: Scope,
  env: { id: string; key: string },
  key: string,
  plan: RolloutPlan,
  now: Date,
): Promise<RolloutPlanView> {
  return scope.db.transaction().execute(async (trx) => {
    await lockEnvironments(trx, [env.id]);
    await requireUnprotected(trx, env, 'rollout plans');
    await requireNote(trx, env, scope.actor.note);
    const flag = await flagWithConfig(trx, scope.project.id, env.id, key);
    if (flag.archived_at !== null) {
      throw new AppError('invalid_argument', `flag "${key}" is archived`);
    }
    const issues = rolloutPlanIssues(plan, { ...flag, variants: flag.variants });
    if (issues.length > 0) throw new AppError('invalid_argument', 'invalid rollout plan', issues);
    if (!flag.enabled) {
      throw new AppError(
        'failed_precondition',
        `flag "${key}" is off in ${env.key}; turn it on before starting a rollout`,
      );
    }
    const live = await trx
      .selectFrom('rollout_plans')
      .select('id')
      .where('flag_id', '=', flag.id)
      .where('environment_id', '=', env.id)
      .where('status', 'in', ['active', 'paused'])
      .executeTakeFirst();
    if (live !== undefined) {
      throw new AppError(
        'already_exists',
        `flag "${key}" already has a rollout in ${env.key}; finish or cancel it first`,
        { id: live.id },
      );
    }
    const nextAt = nextDue(plan, 0, now);
    const row = await trx
      .insertInto('rollout_plans')
      .values({
        flag_id: flag.id,
        environment_id: env.id,
        plan: JSON.stringify(plan),
        status: nextAt === null ? 'completed' : 'active',
        step: 0,
        next_at: nextAt,
        finished_at: nextAt === null ? now : null,
        created_by: scope.actor.id,
        created_by_name: scope.actor.name,
        created_at: now,
        updated_at: now,
      })
      .returning(columns)
      .executeTakeFirstOrThrow();
    await recordAudit(trx, {
      projectId: scope.project.id,
      environmentId: env.id,
      actor: scope.actor,
      action: 'flag.rollout.start',
      targetType: 'flag',
      targetKey: key,
      after: plan,
    });
    await writeConfig(
      trx,
      scope,
      env,
      key,
      (c) => ({ ...c, ...applyStep(c, plan, 0) }),
      undefined,
      'flag.rollout.step',
    );
    return view(row);
  });
}

type Action = 'pause' | 'resume' | 'cancel';

const ALLOWED: Record<Action, readonly RolloutStatus[]> = {
  pause: ['active'],
  resume: ['paused'],
  cancel: ['active', 'paused'],
};

/**
 * Pauses, resumes or cancels a plan. The plan row is locked before the
 * environment, the same order the scheduler takes them in, so the two never
 * deadlock. Resuming restarts the current step's hold, and is refused when the
 * flag is off or its targeted serve was edited since the step was applied,
 * since the next step would silently overwrite that edit.
 */
export async function changeRolloutPlan(
  scope: Scope,
  env: { id: string; key: string },
  key: string,
  id: string,
  action: Action,
  now: Date,
): Promise<RolloutPlanView> {
  return scope.db.transaction().execute(async (trx) => {
    const flagRow = await trx
      .selectFrom('flags')
      .select('id')
      .where('project_id', '=', scope.project.id)
      .where('key', '=', key)
      .executeTakeFirst();
    if (flagRow === undefined) throw notFound(`flag "${key}"`);
    const row = await trx
      .selectFrom('rollout_plans')
      .select(columns)
      .where('id', '=', id)
      .where('flag_id', '=', flagRow.id)
      .where('environment_id', '=', env.id)
      .forUpdate()
      .executeTakeFirst();
    if (row === undefined) throw notFound('rollout plan');
    await lockEnvironments(trx, [env.id]);
    if (!ALLOWED[action].includes(row.status)) {
      throw new AppError('failed_precondition', `cannot ${action} a rollout that is ${row.status}`);
    }
    const plan = row.plan as RolloutPlan;
    let set: Partial<{
      status: RolloutStatus;
      next_at: Date | null;
      paused_reason: PausedReason | null;
      finished_at: Date | null;
    }>;
    if (action === 'pause') {
      set = { status: 'paused', next_at: null, paused_reason: 'manual' };
    } else if (action === 'cancel') {
      set = { status: 'cancelled', next_at: null, paused_reason: null, finished_at: now };
    } else {
      await requireUnprotected(trx, env, 'rollout plans');
      await requireNote(trx, env, scope.actor.note);
      const flag = await flagWithConfig(trx, scope.project.id, env.id, key);
      if (flag.archived_at !== null) {
        throw new AppError('invalid_argument', `flag "${key}" is archived`);
      }
      if (!flag.enabled) {
        throw new AppError(
          'failed_precondition',
          `flag "${key}" is off in ${env.key}; turn it on before resuming`,
        );
      }
      const serve = serveAt(flag, plan.target);
      if (serve === undefined || !sameServe(serve, stepServe(plan, row.step))) {
        throw new AppError(
          'failed_precondition',
          'the targeted serve was edited after this step; cancel the rollout and start a new one',
        );
      }
      set = { status: 'active', next_at: nextDue(plan, row.step, now), paused_reason: null };
    }
    const updated = await trx
      .updateTable('rollout_plans')
      .set({ ...set, updated_at: now })
      .where('id', '=', row.id)
      .returning(columns)
      .executeTakeFirstOrThrow();
    await recordAudit(trx, {
      projectId: scope.project.id,
      environmentId: env.id,
      actor: scope.actor,
      action: `flag.rollout.${action}`,
      targetType: 'flag',
      targetKey: key,
      after: { plan: row.id, step: row.step, weight: plan.steps[row.step]?.weight ?? 0 },
    });
    return view(updated);
  });
}

export type StepResult = 'applied' | 'completed' | 'paused' | 'failed' | 'cancelled';

/** A due plan the scheduler has claimed with FOR UPDATE SKIP LOCKED. */
export interface ClaimedPlan {
  id: string;
  plan: unknown;
  step: number;
  created_by_name: string;
  flag_key: string;
  environment_id: string;
  environment_key: string;
  project_id: string;
  project_key: string;
  project_name: string;
}

/**
 * Applies the next step of a claimed plan, inside the claiming transaction,
 * so the step and the plan's new position commit together and happen once.
 * The flag is read after the environment lock: a plan whose flag was turned
 * off pauses, one whose serve was edited by hand pauses rather than
 * overwriting the edit, and a step that no longer validates fails the plan.
 */
export async function advanceRolloutPlan(
  trx: ControlledTransaction<Database>,
  due: ClaimedPlan,
  retention: number,
  now: Date,
): Promise<StepResult> {
  const env = { id: due.environment_id, key: due.environment_key };
  await lockEnvironments(trx, [env.id]);
  const finish = async (
    status: RolloutStatus,
    extra: { error?: string; paused_reason?: PausedReason; step?: number; next_at?: Date | null },
  ) => {
    await trx
      .updateTable('rollout_plans')
      .set({
        status,
        next_at: extra.next_at ?? null,
        paused_reason: extra.paused_reason ?? null,
        error: extra.error ?? null,
        ...(extra.step === undefined ? {} : { step: extra.step }),
        ...(status === 'active' || status === 'paused' ? {} : { finished_at: now }),
        updated_at: now,
      })
      .where('id', '=', due.id)
      .execute();
  };
  const parsed = rolloutPlanSchema.safeParse(due.plan);
  if (!parsed.success || due.step >= parsed.data.steps.length - 1) {
    await finish('failed', { error: 'stored plan is not a valid rollout plan' });
    return 'failed';
  }
  const plan = parsed.data;
  const flag = await flagWithConfig(trx, due.project_id, env.id, due.flag_key);
  if (flag.archived_at !== null) {
    await finish('cancelled', { error: 'flag was archived' });
    return 'cancelled';
  }
  if (!flag.enabled) {
    await finish('paused', { paused_reason: 'kill_switch' });
    return 'paused';
  }
  const serve = serveAt(flag, plan.target);
  if (serve === undefined) {
    const rule = typeof plan.target === 'object' ? plan.target.rule : '';
    await finish('failed', { error: `rule "${rule}" no longer exists` });
    return 'failed';
  }
  if (!sameServe(serve, stepServe(plan, due.step))) {
    await finish('paused', { paused_reason: 'edited' });
    return 'paused';
  }
  const step = due.step + 1;
  const scope: Scope = {
    db: trx,
    project: { id: due.project_id, key: due.project_key, name: due.project_name },
    actor: { id: null, name: `Rollout by ${due.created_by_name}` },
    retention,
  };
  const sp = await trx.savepoint('step').execute();
  try {
    await writeConfig(
      sp,
      scope,
      env,
      due.flag_key,
      (c) => ({ ...c, ...applyStep(c, plan, step) }),
      undefined,
      'flag.rollout.step',
    );
    await sp.releaseSavepoint('step').execute();
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    await sp.rollbackToSavepoint('step').execute();
    const details = Array.isArray(err.details)
      ? (err.details as { path: string; message: string }[]).map((d) => `${d.path}: ${d.message}`)
      : [];
    await finish('failed', { error: [err.message, ...details].join('; ').slice(0, 1000) });
    return 'failed';
  }
  const nextAt = nextDue(plan, step, now);
  await finish(nextAt === null ? 'completed' : 'active', { step, next_at: nextAt });
  return nextAt === null ? 'completed' : 'applied';
}
