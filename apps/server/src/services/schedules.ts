import { ruleSchema, serveSchema, LIMITS } from '@flagship/core';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Db } from '../db/database.js';
import type { ScheduleStatus } from '../db/schema.js';
import { AppError, notFound } from '../errors.js';
import type { Metrics } from '../metrics.js';
import { recordAudit, type Actor } from './audit.js';
import { validateCandidate, writeConfig, type EnvConfig, type Scope } from './flags.js';
import { toFlag } from './rulesets.js';

export const changeSchema = z
  .strictObject({
    enabled: z.boolean().optional(),
    fallthrough: serveSchema.optional(),
    rules: z.array(ruleSchema).max(LIMITS.rulesPerFlag).optional(),
  })
  .refine((c) => c.enabled !== undefined || c.fallthrough !== undefined || c.rules !== undefined, {
    message: 'a scheduled change must set enabled, fallthrough or rules',
  });

export type ScheduledChange = z.infer<typeof changeSchema>;

export interface ScheduleView {
  id: string;
  runAt: string;
  change: ScheduledChange;
  status: ScheduleStatus;
  error: string | null;
  createdBy: string;
  createdAt: string;
  finishedAt: string | null;
}

export function applyChange(config: EnvConfig, change: ScheduledChange): EnvConfig {
  return {
    ...config,
    ...(change.enabled === undefined ? {} : { enabled: change.enabled }),
    ...(change.fallthrough === undefined ? {} : { fallthrough: change.fallthrough }),
    ...(change.rules === undefined ? {} : { rules: change.rules }),
  };
}

interface ScheduleRow {
  id: string;
  run_at: Date;
  change: unknown;
  status: ScheduleStatus;
  error: string | null;
  created_by_name: string;
  created_at: Date;
  finished_at: Date | null;
}

function view(r: ScheduleRow): ScheduleView {
  return {
    id: r.id,
    runAt: r.run_at.toISOString(),
    change: r.change as ScheduledChange,
    status: r.status,
    error: r.error,
    createdBy: r.created_by_name,
    createdAt: r.created_at.toISOString(),
    finishedAt: r.finished_at?.toISOString() ?? null,
  };
}

const columns = [
  'id',
  'run_at',
  'change',
  'status',
  'error',
  'created_by_name',
  'created_at',
  'finished_at',
] as const;

async function flagAndConfig(db: Db, projectId: string, environmentId: string, key: string) {
  const row = await db
    .selectFrom('flags')
    .innerJoin('flag_configs', 'flag_configs.flag_id', 'flags.id')
    .selectAll('flags')
    .select([
      'flag_configs.enabled',
      'flag_configs.off_variant',
      'flag_configs.prerequisites',
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

export async function listSchedules(
  db: Db,
  projectId: string,
  environmentId: string,
  key: string,
): Promise<ScheduleView[]> {
  const flag = await flagAndConfig(db, projectId, environmentId, key);
  const rows = await db
    .selectFrom('scheduled_changes')
    .select(columns)
    .where('flag_id', '=', flag.id)
    .where('environment_id', '=', environmentId)
    .orderBy('run_at', 'desc')
    .limit(100)
    .execute();
  return rows.map(view);
}

/**
 * Stores a change to run later. It is checked against today's ruleset now,
 * to catch typos early, and again when it runs, because the flag may have
 * changed in between.
 */
export async function createSchedule(
  scope: Scope,
  env: { id: string },
  key: string,
  input: { runAt: Date; change: ScheduledChange },
  now: Date,
): Promise<ScheduleView> {
  if (input.runAt.getTime() <= now.getTime()) {
    throw new AppError('invalid_argument', 'runAt must be in the future', [
      { path: 'runAt', message: 'must be in the future' },
    ]);
  }
  if (input.runAt.getTime() > now.getTime() + 366 * 86_400_000) {
    throw new AppError('invalid_argument', 'runAt must be within a year', [
      { path: 'runAt', message: 'must be within a year' },
    ]);
  }
  return scope.db.transaction().execute(async (trx) => {
    const flag = await flagAndConfig(trx, scope.project.id, env.id, key);
    if (flag.archived_at !== null)
      throw new AppError('invalid_argument', `flag "${key}" is archived`);
    const next = applyChange(
      {
        enabled: flag.enabled,
        offVariant: flag.off_variant,
        prerequisites: flag.prerequisites,
        rules: flag.rules,
        fallthrough: flag.fallthrough,
      },
      input.change,
    );
    await validateCandidate(trx, env.id, (rs) => {
      rs.flags[key] = toFlag(flag, {
        enabled: next.enabled,
        off_variant: next.offVariant,
        prerequisites: next.prerequisites,
        rules: next.rules,
        fallthrough: next.fallthrough,
      });
    });
    const row = await trx
      .insertInto('scheduled_changes')
      .values({
        flag_id: flag.id,
        environment_id: env.id,
        run_at: input.runAt,
        change: JSON.stringify(input.change),
        created_by: scope.actor.id,
        created_by_name: scope.actor.name,
      })
      .returning(columns)
      .executeTakeFirstOrThrow();
    await recordAudit(trx, {
      projectId: scope.project.id,
      environmentId: env.id,
      actor: scope.actor,
      action: 'flag.schedule.create',
      targetType: 'flag',
      targetKey: key,
      after: { runAt: input.runAt.toISOString(), change: input.change },
    });
    return view(row);
  });
}

export async function cancelSchedule(
  scope: Scope,
  env: { id: string },
  key: string,
  id: string,
  now: Date,
): Promise<ScheduleView> {
  return scope.db.transaction().execute(async (trx) => {
    const flag = await flagAndConfig(trx, scope.project.id, env.id, key);
    const row = await trx
      .updateTable('scheduled_changes')
      .set({ status: 'cancelled', finished_at: now })
      .where('id', '=', id)
      .where('flag_id', '=', flag.id)
      .where('environment_id', '=', env.id)
      .where('status', '=', 'pending')
      .returning(columns)
      .executeTakeFirst();
    if (row === undefined) throw notFound('pending scheduled change');
    await recordAudit(trx, {
      projectId: scope.project.id,
      environmentId: env.id,
      actor: scope.actor,
      action: 'flag.schedule.cancel',
      targetType: 'flag',
      targetKey: key,
      before: { runAt: row.run_at.toISOString(), change: row.change },
    });
    return view(row);
  });
}

export interface SchedulerOptions {
  db: Db;
  metrics: Metrics;
  logger: Logger;
  now: () => Date;
  intervalMs: number;
  retention: number;
  batch?: number;
  /** Bounded clean-up jobs run from the same loop, each at most every `everyMs`. */
  housekeeping?: HousekeepingJob[];
}

export interface HousekeepingJob {
  name: string;
  everyMs: number;
  /** Does a bounded amount of work and returns how many rows it removed. */
  run: (now: Date) => Promise<number>;
}

/**
 * Applies due scheduled changes. Each change is claimed with
 * FOR UPDATE SKIP LOCKED inside its own transaction, so any number of server
 * instances can run this loop and a change is applied exactly once. The
 * apply goes through the same path as a manual edit (validation, version
 * bump, audit, stream patch) inside a savepoint: if it no longer validates,
 * the savepoint is rolled back and the row is marked failed with the reason.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<number> | null = null;
  private readonly lastRun = new Map<string, number>();

  constructor(private readonly o: SchedulerOptions) {}

  start(): void {
    this.timer = setInterval(() => {
      if (this.running === null) {
        this.running = this.runOnce()
          .catch((err: unknown) => {
            this.o.logger.error({ err }, 'scheduler run failed');
            return 0;
          })
          .finally(() => {
            this.running = null;
          });
      }
    }, this.o.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  /** Applies due changes until none are left; returns how many it processed. */
  async runOnce(): Promise<number> {
    let processed = 0;
    for (let i = 0; i < (this.o.batch ?? 100); i++) {
      if (!(await this.applyNext())) break;
      processed++;
    }
    await this.housekeep();
    return processed;
  }

  /**
   * Runs each housekeeping job that is due. A failing job is logged and
   * retried on its next turn; it never stops scheduled changes from applying.
   */
  async housekeep(): Promise<void> {
    for (const job of this.o.housekeeping ?? []) {
      const now = this.o.now();
      const last = this.lastRun.get(job.name);
      if (last !== undefined && now.getTime() - last < job.everyMs) continue;
      this.lastRun.set(job.name, now.getTime());
      try {
        const removed = await job.run(now);
        if (removed > 0) this.o.logger.debug({ job: job.name, removed }, 'housekeeping');
      } catch (err) {
        this.o.logger.warn({ err, job: job.name }, 'housekeeping failed');
      }
    }
  }

  private async applyNext(): Promise<boolean> {
    const trx = await this.o.db.startTransaction().execute();
    try {
      const due = await trx
        .selectFrom('scheduled_changes')
        .innerJoin('flags', 'flags.id', 'scheduled_changes.flag_id')
        .innerJoin('environments', 'environments.id', 'scheduled_changes.environment_id')
        .innerJoin('projects', 'projects.id', 'flags.project_id')
        .select([
          'scheduled_changes.id',
          'scheduled_changes.change',
          'scheduled_changes.created_by_name',
          'flags.key as flag_key',
          'environments.id as environment_id',
          'environments.key as environment_key',
          'projects.id as project_id',
          'projects.key as project_key',
          'projects.name as project_name',
        ])
        .where('scheduled_changes.status', '=', 'pending')
        .where('scheduled_changes.run_at', '<=', this.o.now())
        .orderBy('scheduled_changes.run_at')
        .limit(1)
        .forUpdate('scheduled_changes')
        .skipLocked()
        .executeTakeFirst();
      if (due === undefined) {
        await trx.rollback().execute();
        return false;
      }
      const actor: Actor = { id: null, name: `Scheduled by ${due.created_by_name}` };
      const scope: Scope = {
        db: trx,
        project: { id: due.project_id, key: due.project_key, name: due.project_name },
        actor,
        retention: this.o.retention,
      };
      const parsed = changeSchema.safeParse(due.change);
      let status: ScheduleStatus = 'applied';
      let error: string | null = null;
      if (!parsed.success) {
        // A row that no longer parses would otherwise be retried on every tick.
        status = 'failed';
        error = 'stored change is not a valid scheduled change';
      } else {
        const change = parsed.data;
        const sp = await trx.savepoint('apply').execute();
        try {
          await writeConfig(
            sp,
            scope,
            { id: due.environment_id, key: due.environment_key },
            due.flag_key,
            (c) => applyChange(c, change),
            undefined,
            'flag.schedule.apply',
          );
          await sp.releaseSavepoint('apply').execute();
        } catch (err) {
          if (!(err instanceof AppError)) throw err;
          await sp.rollbackToSavepoint('apply').execute();
          status = 'failed';
          const details = Array.isArray(err.details)
            ? (err.details as { path: string; message: string }[]).map(
                (d) => `${d.path}: ${d.message}`,
              )
            : [];
          error = [err.message, ...details].join('; ').slice(0, 1000);
        }
      }
      await trx
        .updateTable('scheduled_changes')
        .set({ status, error, finished_at: this.o.now() })
        .where('id', '=', due.id)
        .execute();
      await trx.commit().execute();
      this.o.metrics.schedules.inc({ result: status });
      this.o.logger.info(
        { schedule: due.id, flag: due.flag_key, environment: due.environment_key, status },
        'scheduled change processed',
      );
      return true;
    } catch (err) {
      await trx.rollback().execute();
      throw err;
    }
  }
}
