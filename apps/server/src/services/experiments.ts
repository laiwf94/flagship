import {
  keySchema,
  rolloutTargetSchema,
  sameServe,
  serveAt,
  type Rollout,
  type RolloutTarget,
} from '@flagship/core';
import {
  relativeLift,
  sampleRatioMismatch,
  studentTQuantile,
  summarize,
  welchTTest,
  wilsonInterval,
  type Interval,
  type Summary,
} from '@flagship/stats';
import { sql } from 'kysely';
import { z } from 'zod';
import type { Db } from '../db/database.js';
import type { ExperimentStatus } from '../db/schema.js';
import { AppError, notFound } from '../errors.js';
import { recordAudit } from './audit.js';
import { requireNote, type Scope } from './flags.js';
import { lockEnvironments } from './rulesets.js';
import { cohortHour, rolledUpConversions, type RolledUpVariant } from './experimentRollup.js';

/** Results are two-sided 95% intervals. */
export const CONFIDENCE = 0.95;
/** A sample ratio check below this p-value hides the results behind a warning. */
export const SRM_THRESHOLD = 0.001;
export const MAX_METRICS = 10;

/**
 * What a metric measures per exposed context, over the attribution window:
 * - conversion: whether the context converted at least once (a rate)
 * - count: how many times it converted
 * - value: the sum of its conversions' values (revenue, say)
 */
export const METRIC_KINDS = ['conversion', 'count', 'value'] as const;
export type MetricKind = (typeof METRIC_KINDS)[number];

export const metricSchema = z.strictObject({
  event: keySchema,
  kind: z.enum(METRIC_KINDS).default('conversion'),
});
export type Metric = z.infer<typeof metricSchema>;

export const experimentInput = z.strictObject({
  key: keySchema,
  name: z.string().trim().min(1).max(100),
  hypothesis: z.string().max(2000).optional(),
  flag: keySchema,
  environment: keySchema,
  target: rolloutTargetSchema.default('fallthrough'),
  control: keySchema,
  metrics: z
    .array(metricSchema)
    .min(1)
    .max(MAX_METRICS)
    .refine(
      (ms) => new Set(ms.map((m) => `${m.event}|${m.kind}`)).size === ms.length,
      'each event and kind may appear once',
    ),
});
export type ExperimentInput = z.infer<typeof experimentInput>;

export interface ExperimentView {
  id: string;
  key: string;
  name: string;
  hypothesis: string;
  flag: string;
  environment: string;
  target: RolloutTarget;
  /** The split at the target when the experiment started. */
  allocation: Rollout;
  control: string;
  /** The first metric is the primary one. */
  metrics: Metric[];
  status: ExperimentStatus;
  startedAt: string;
  stoppedAt: string | null;
  stoppedReason: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

function experiments(db: Db) {
  return db
    .selectFrom('experiments')
    .innerJoin('flags', 'flags.id', 'experiments.flag_id')
    .innerJoin('environments', 'environments.id', 'experiments.environment_id')
    .select([
      'experiments.id',
      'experiments.project_id',
      'experiments.environment_id',
      'experiments.flag_id',
      'experiments.key',
      'experiments.name',
      'experiments.hypothesis',
      'experiments.target',
      'experiments.allocation',
      'experiments.control',
      'experiments.metrics',
      'experiments.status',
      'experiments.started_at',
      'experiments.stopped_at',
      'experiments.stopped_reason',
      'experiments.created_by_name',
      'experiments.created_at',
      'experiments.updated_at',
      'flags.key as flag_key',
      'environments.key as environment_key',
    ]);
}

type Row = Awaited<ReturnType<ReturnType<typeof experiments>['executeTakeFirstOrThrow']>>;

function view(r: Row): ExperimentView {
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    hypothesis: r.hypothesis,
    flag: r.flag_key,
    environment: r.environment_key,
    target: r.target as RolloutTarget,
    allocation: r.allocation as Rollout,
    control: r.control,
    metrics: r.metrics as Metric[],
    status: r.status,
    startedAt: r.started_at.toISOString(),
    stoppedAt: r.stopped_at?.toISOString() ?? null,
    stoppedReason: r.stopped_reason,
    createdBy: r.created_by_name,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export async function listExperiments(
  db: Db,
  projectId: string,
  q: { environmentId?: string; flag?: string; status?: ExperimentStatus; limit?: number },
): Promise<ExperimentView[]> {
  const rows = await experiments(db)
    .where('experiments.project_id', '=', projectId)
    .$if(q.environmentId !== undefined, (b) =>
      b.where('experiments.environment_id', '=', q.environmentId as string),
    )
    .$if(q.flag !== undefined, (b) => b.where('flags.key', '=', q.flag as string))
    .$if(q.status !== undefined, (b) =>
      b.where('experiments.status', '=', q.status as ExperimentStatus),
    )
    .orderBy('experiments.created_at', 'desc')
    .orderBy('experiments.id', 'desc')
    .limit(q.limit ?? 100)
    .execute();
  return rows.map(view);
}

async function experimentRow(db: Db, projectId: string, key: string): Promise<Row> {
  const row = await experiments(db)
    .where('experiments.project_id', '=', projectId)
    .where('experiments.key', '=', key)
    .executeTakeFirst();
  if (row === undefined) throw notFound(`experiment "${key}"`);
  return row;
}

export async function getExperiment(db: Db, projectId: string, key: string) {
  return view(await experimentRow(db, projectId, key));
}

/**
 * The split an experiment can read at a serve, or a reason it can't: the
 * serve must be a percentage rollout that gives the control and at least one
 * other variant some traffic.
 */
export function allocationIssue(
  serve: ReturnType<typeof serveAt>,
  control: string,
): string | undefined {
  if (serve === undefined) return 'the targeted rule does not exist';
  if (!('rollout' in serve)) return 'the targeted serve is not a percentage rollout';
  const live = serve.rollout.variants.filter((v) => v.weight > 0);
  if (!live.some((v) => v.variant === control)) {
    return `the control variant "${control}" gets no traffic at the targeted serve`;
  }
  if (live.length < 2) return 'the targeted rollout gives traffic to only one variant';
  return undefined;
}

/**
 * Starts an experiment on a flag's current split. Starting changes no
 * targeting, so it is allowed in protected environments; the reason and
 * link rules still apply, and the start is audited on the flag.
 */
export async function startExperiment(
  scope: Scope,
  env: { id: string; key: string },
  input: ExperimentInput,
  now: Date,
): Promise<ExperimentView> {
  const id = await scope.db.transaction().execute(async (trx) => {
    // The environment lock serializes this with targeting writes, so the
    // allocation recorded is the one live when the experiment starts.
    await lockEnvironments(trx, [env.id]);
    await requireNote(trx, env, scope.actor.note);
    const flag = await trx
      .selectFrom('flags')
      .innerJoin('flag_configs', 'flag_configs.flag_id', 'flags.id')
      .select([
        'flags.id',
        'flags.variants',
        'flags.archived_at',
        'flag_configs.rules',
        'flag_configs.fallthrough',
      ])
      .where('flags.project_id', '=', scope.project.id)
      .where('flags.key', '=', input.flag)
      .where('flag_configs.environment_id', '=', env.id)
      .executeTakeFirst();
    if (flag === undefined) throw notFound(`flag "${input.flag}"`);
    if (flag.archived_at !== null) {
      throw new AppError('invalid_argument', `flag "${input.flag}" is archived`);
    }
    if (!flag.variants.some((v) => v.key === input.control)) {
      throw new AppError('invalid_argument', 'invalid experiment', [
        { path: 'control', message: `flag "${input.flag}" has no variant "${input.control}"` },
      ]);
    }
    const serve = serveAt(flag, input.target);
    const issue = allocationIssue(serve, input.control);
    if (issue !== undefined || serve === undefined || !('rollout' in serve)) {
      throw new AppError('failed_precondition', `cannot start an experiment: ${issue ?? ''}`);
    }
    const taken = await trx
      .selectFrom('experiments')
      .select(['key', 'flag_id', 'environment_id', 'status'])
      .where((eb) =>
        eb.or([
          eb.and([eb('project_id', '=', scope.project.id), eb('key', '=', input.key)]),
          eb.and([
            eb('flag_id', '=', flag.id),
            eb('environment_id', '=', env.id),
            eb('status', '=', 'running'),
          ]),
        ]),
      )
      .execute();
    if (taken.some((t) => t.key === input.key)) {
      throw new AppError('already_exists', `experiment "${input.key}" already exists`);
    }
    if (taken.length > 0) {
      throw new AppError(
        'already_exists',
        `flag "${input.flag}" already has a running experiment in ${env.key}; stop it first`,
        { experiment: taken[0]?.key },
      );
    }
    const row = await trx
      .insertInto('experiments')
      .values({
        project_id: scope.project.id,
        environment_id: env.id,
        flag_id: flag.id,
        key: input.key,
        name: input.name,
        hypothesis: input.hypothesis ?? '',
        target: JSON.stringify(input.target),
        allocation: JSON.stringify(serve.rollout),
        control: input.control,
        metrics: JSON.stringify(input.metrics),
        started_at: now,
        created_by: scope.actor.id,
        created_by_name: scope.actor.name,
        created_at: now,
        updated_at: now,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await recordAudit(trx, {
      projectId: scope.project.id,
      environmentId: env.id,
      actor: scope.actor,
      action: 'flag.experiment.start',
      targetType: 'flag',
      targetKey: input.flag,
      after: {
        experiment: input.key,
        target: input.target,
        allocation: serve.rollout,
        control: input.control,
        metrics: input.metrics,
      },
    });
    return row.id;
  });
  const row = await experiments(scope.db).where('experiments.id', '=', id).executeTakeFirst();
  if (row === undefined) throw notFound(`experiment "${input.key}"`);
  return view(row);
}

/** Stops a running experiment; contexts first exposed after the stop hour no longer count. */
export async function stopExperiment(
  scope: Scope,
  key: string,
  now: Date,
): Promise<ExperimentView> {
  return scope.db.transaction().execute(async (trx) => {
    const row = await experimentRow(trx, scope.project.id, key);
    const env = { id: row.environment_id, key: row.environment_key };
    await requireNote(trx, env, scope.actor.note);
    const stopped = await trx
      .updateTable('experiments')
      .set({ status: 'stopped', stopped_at: now, stopped_reason: 'manual', updated_at: now })
      .where('id', '=', row.id)
      .where('status', '=', 'running')
      .returning('id')
      .executeTakeFirst();
    if (stopped === undefined) {
      throw new AppError('failed_precondition', `experiment "${key}" is already stopped`);
    }
    await recordAudit(trx, {
      projectId: scope.project.id,
      environmentId: env.id,
      actor: scope.actor,
      action: 'flag.experiment.stop',
      targetType: 'flag',
      targetKey: row.flag_key,
      after: { experiment: key },
    });
    return view(await experimentRow(trx, scope.project.id, key));
  });
}

/** Stops the running experiments of a flag being archived, inside that write. */
export async function stopExperimentsForArchive(
  trx: Db,
  flagId: string,
  now: Date,
): Promise<number> {
  const r = await trx
    .updateTable('experiments')
    .set({
      status: 'stopped',
      // Never before the start, whichever clock wrote it.
      stopped_at: sql<Date>`greatest(started_at, ${now})`,
      stopped_reason: 'flag archived',
      updated_at: now,
    })
    .where('flag_id', '=', flagId)
    .where('status', '=', 'running')
    .executeTakeFirst();
  return Number(r.numUpdatedRows);
}

// ---------------------------------------------------------------------------
// Results

export interface SampleRatioView {
  statistic: number;
  df: number;
  pValue: number;
  threshold: number;
  mismatch: boolean;
}

export interface Comparison {
  /** Treatment mean − control mean, with Welch's interval. */
  difference: number;
  differenceInterval: Interval;
  /** Treatment mean / control mean − 1, with a delta-method interval; null when the control mean is 0. */
  lift: number | null;
  liftInterval: Interval | null;
  /** Welch's two-sided p-value for the difference. */
  pValue: number;
  significant: boolean;
}

export interface MetricVariant {
  variant: string;
  exposed: number;
  /** Contexts that converted at least once. */
  converted: number;
  conversions: number;
  value: number;
  /** Per exposed context: the conversion rate, mean count or mean value; null with no exposures. */
  mean: number | null;
  /** 95% interval for the mean: Wilson for a rate, Student's t otherwise. */
  interval: Interval | null;
  /** Against the control; null for the control and when either side has fewer than two contexts. */
  comparison: Comparison | null;
}

export interface MetricResult {
  event: string;
  kind: MetricKind;
  variants: MetricVariant[];
}

export interface AllocationVariant {
  variant: string;
  /** Out of ROLLOUT_TOTAL in the recorded allocation; 0 for a variant the split never served. */
  weight: number;
  exposed: number;
  expected: number;
}

export interface ExperimentResults {
  experiment: ExperimentView;
  /** First-exposure hours counted, [from, to); `to` is null while running. */
  window: { from: string; to: string | null };
  confidence: number;
  exposed: number;
  variants: AllocationVariant[];
  srm: SampleRatioView;
  /** Whether the live split at the target still matches the allocation the experiment started on. */
  allocationChanged: boolean;
  /**
   * Set when the sample ratio check failed and the caller didn't ask to see
   * the results anyway: `metrics` is then null, since a broken split makes
   * every comparison suspect.
   */
  warning: { code: 'sample_ratio_mismatch'; message: string } | null;
  metrics: MetricResult[] | null;
}

function meanInterval(kind: MetricKind, s: Summary, converted: number): Interval | null {
  if (kind === 'conversion') return wilsonInterval(converted, s.n, { confidence: CONFIDENCE });
  if (s.n < 2) return null;
  const half = studentTQuantile(1 - (1 - CONFIDENCE) / 2, s.n - 1) * Math.sqrt(s.variance / s.n);
  return { lower: s.mean - half, upper: s.mean + half };
}

function metricSummary(kind: MetricKind, n: number, r: RolledUpVariant | undefined): Summary {
  if (r === undefined) return summarize(n, 0, 0);
  if (kind === 'conversion') return summarize(n, r.converted, r.converted);
  if (kind === 'count') return summarize(n, r.conversions, r.conversionSquares);
  return summarize(n, r.value, r.valueSquares);
}

export interface AnalysisInput {
  control: string;
  allocation: Rollout;
  metrics: readonly Metric[];
  /** Exposed contexts per variant. */
  exposed: ReadonlyMap<string, number>;
  /** Rolled-up conversions per metric event, by variant. */
  conversions: ReadonlyMap<string, readonly RolledUpVariant[]>;
  showMismatched?: boolean;
}

/**
 * Turns rolled-up counts into results. Variants follow the allocation's
 * order, control first; a variant that got exposures without being in the
 * split is added with weight 0, which the sample ratio check treats as a
 * certain mismatch. Pure, so it can be checked without a database.
 */
export function analyze(
  input: AnalysisInput,
): Pick<ExperimentResults, 'exposed' | 'variants' | 'srm' | 'warning' | 'metrics' | 'confidence'> {
  const weights = new Map<string, number>();
  for (const v of input.allocation.variants) {
    weights.set(v.variant, (weights.get(v.variant) ?? 0) + v.weight);
  }
  const names = [input.control, ...[...weights.keys()].filter((k) => k !== input.control)];
  for (const k of [...input.exposed.keys()].sort()) if (!names.includes(k)) names.push(k);
  const observed = names.map((k) => input.exposed.get(k) ?? 0);
  const ratio = sampleRatioMismatch(
    observed,
    names.map((k) => weights.get(k) ?? 0),
    { threshold: SRM_THRESHOLD },
  );
  const variants = names.map((variant, i) => ({
    variant,
    weight: weights.get(variant) ?? 0,
    exposed: observed[i] as number,
    expected: ratio.expected[i] as number,
  }));
  const srm: SampleRatioView = {
    statistic: ratio.statistic,
    df: ratio.df,
    pValue: ratio.pValue,
    threshold: SRM_THRESHOLD,
    mismatch: ratio.mismatch,
  };
  const exposed = observed.reduce((a, b) => a + b, 0);
  if (ratio.mismatch && input.showMismatched !== true) {
    return {
      confidence: CONFIDENCE,
      exposed,
      variants,
      srm,
      warning: {
        code: 'sample_ratio_mismatch',
        message:
          `The traffic split does not match the allocation (chi-square p = ${ratio.pValue.toPrecision(3)}, ` +
          `below ${SRM_THRESHOLD}). Results are hidden because assignment or exposure ` +
          'reporting is broken; find the cause before reading them.',
      },
      metrics: null,
    };
  }
  const metrics = input.metrics.map((m): MetricResult => {
    const rows = new Map((input.conversions.get(m.event) ?? []).map((r) => [r.variant, r]));
    const summaries = variants.map((v) => metricSummary(m.kind, v.exposed, rows.get(v.variant)));
    const control = summaries[0] as Summary;
    return {
      event: m.event,
      kind: m.kind,
      variants: variants.map((v, i): MetricVariant => {
        const s = summaries[i] as Summary;
        const r = rows.get(v.variant);
        let comparison: Comparison | null = null;
        if (i > 0) {
          const welch = welchTTest(control, s, { confidence: CONFIDENCE });
          if (welch !== null) {
            const lift = relativeLift(control, s, { confidence: CONFIDENCE });
            comparison = {
              difference: welch.difference,
              differenceInterval: welch.interval,
              lift: lift?.lift ?? null,
              liftInterval: lift?.interval ?? null,
              pValue: welch.pValue,
              significant: welch.pValue < 1 - CONFIDENCE,
            };
          }
        }
        return {
          variant: v.variant,
          exposed: v.exposed,
          converted: r?.converted ?? 0,
          conversions: r?.conversions ?? 0,
          value: r?.value ?? 0,
          mean: s.n === 0 ? null : s.mean,
          interval: meanInterval(m.kind, s, r?.converted ?? 0),
          comparison,
        };
      }),
    };
  });
  return { confidence: CONFIDENCE, exposed, variants, srm, warning: null, metrics };
}

/**
 * Results of an experiment from the hourly rollup, counting contexts first
 * exposed from the hour it started in to the hour it stopped in, with
 * conversions inside the attribution window of each exposure.
 */
export async function experimentResults(
  db: Db,
  projectId: string,
  key: string,
  o: { showMismatched?: boolean } = {},
): Promise<ExperimentResults> {
  const row = await experimentRow(db, projectId, key);
  const experiment = view(row);
  const range = {
    environmentId: row.environment_id,
    flag: row.flag_key,
    from: row.started_at,
    ...(row.stopped_at === null ? {} : { to: row.stopped_at }),
  };
  const events = [...new Set(experiment.metrics.map((m) => m.event))];
  const perEvent = await Promise.all(
    events.map(
      async (event) => [event, await rolledUpConversions(db, { ...range, event })] as const,
    ),
  );
  const conversions = new Map(perEvent);
  // Every row carries the variant's exposed count, whatever the event.
  const exposed = new Map((perEvent[0]?.[1] ?? []).map((r) => [r.variant, r.exposed]));
  const config = await db
    .selectFrom('flag_configs')
    .select(['rules', 'fallthrough'])
    .where('flag_id', '=', row.flag_id)
    .where('environment_id', '=', row.environment_id)
    .executeTakeFirstOrThrow();
  const live = serveAt(config, experiment.target);
  const allocationChanged =
    live === undefined || !sameServe(live, { rollout: experiment.allocation });
  const from = cohortHour(row.started_at);
  const to =
    row.stopped_at === null ? null : new Date(cohortHour(row.stopped_at).getTime() + 3_600_000);
  return {
    experiment,
    window: { from: from.toISOString(), to: to?.toISOString() ?? null },
    allocationChanged,
    ...analyze({
      control: experiment.control,
      allocation: experiment.allocation,
      metrics: experiment.metrics,
      exposed,
      conversions,
      ...(o.showMismatched === undefined ? {} : { showMismatched: o.showMismatched }),
    }),
  };
}
