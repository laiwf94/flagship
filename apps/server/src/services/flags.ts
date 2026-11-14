import {
  validateRuleset,
  type Flag,
  type Lifecycle,
  type Ruleset,
  type Variant,
} from '@flagship/core';
import { sql } from 'kysely';
import type { Db } from '../db/database.js';
import { AppError, notFound } from '../errors.js';
import { stopExperimentsForArchive } from './experiments.js';
import { recordAudit, type Actor, type ChangeNote } from './audit.js';
import { lifecycleFromRow, lifecycleQuery } from './lifecycle.js';
import type { ProjectRow } from './projects.js';
import {
  loadRuleset,
  lockEnvironments,
  recordChange,
  toFlag,
  type ConfigRow,
  type FlagRow,
} from './rulesets.js';

export type FlagStatus = 'on' | 'off' | 'rollout' | 'archived';

export interface EnvConfig {
  enabled: boolean;
  offVariant: string;
  prerequisites: Flag['prerequisites'];
  rules: Flag['rules'];
  fallthrough: Flag['fallthrough'];
}

export interface FlagView {
  key: string;
  name: string;
  description: string;
  type: Flag['type'];
  variants: Variant[];
  clientSide: boolean;
  salt: string;
  archived: boolean;
  /** Metadata version: name, description, variants, client side, archived. */
  version: number;
  createdAt: string;
  /** The latest change to the metadata or to any environment's targeting. */
  updatedAt: string;
  /** Each environment's targeting, with its own version. */
  environments: Record<string, EnvConfig & { version: number; updatedAt: string }>;
}

export interface FlagSummary {
  key: string;
  name: string;
  description: string;
  type: Flag['type'];
  clientSide: boolean;
  /** Metadata version. */
  version: number;
  /** Targeting version in the listed environment. */
  targetingVersion: number;
  /** The latest change to the metadata or to the listed environment's targeting. */
  updatedAt: string;
  status: FlagStatus;
  ruleCount: number;
  /** Stage in the listed environment, and why it is stale when it is. */
  lifecycle: Lifecycle;
  /** Start of the latest hour it was evaluated in the listed environment. */
  lastEvaluatedAt: string | null;
}

export interface FlagInput {
  key: string;
  name: string;
  description?: string | undefined;
  type: Flag['type'];
  variants?: Variant[] | undefined;
  clientSide?: boolean | undefined;
}

export interface FlagPatch {
  version: number;
  name?: string | undefined;
  description?: string | undefined;
  variants?: Variant[] | undefined;
  clientSide?: boolean | undefined;
}

export interface Scope {
  db: Db;
  project: ProjectRow;
  actor: Actor;
  retention: number;
}

const BOOLEAN_VARIANTS: Variant[] = [
  { key: 'on', value: true },
  { key: 'off', value: false },
];

const STATUS = sql<FlagStatus>`CASE
  WHEN flags.archived_at IS NOT NULL THEN 'archived'
  WHEN NOT flag_configs.enabled THEN 'off'
  WHEN flag_configs.fallthrough ? 'rollout'
    OR jsonb_path_exists(flag_configs.rules, '$[*].serve.rollout') THEN 'rollout'
  ELSE 'on' END`;

export function defaultEnvConfig(variants: readonly Variant[]): EnvConfig {
  const off = (variants.find((v) => v.value === false) ?? variants[0])?.key ?? 'off';
  return {
    enabled: false,
    offVariant: off,
    prerequisites: [],
    rules: [],
    fallthrough: { variant: off },
  };
}

export function configColumns(c: EnvConfig) {
  return {
    enabled: c.enabled,
    off_variant: c.offVariant,
    prerequisites: JSON.stringify(c.prerequisites),
    rules: JSON.stringify(c.rules),
    fallthrough: JSON.stringify(c.fallthrough),
  };
}

export function configView(
  c: Pick<ConfigRow, 'enabled' | 'off_variant' | 'prerequisites' | 'rules' | 'fallthrough'>,
): EnvConfig {
  return {
    enabled: c.enabled,
    offVariant: c.off_variant,
    prerequisites: c.prerequisites,
    rules: c.rules,
    fallthrough: c.fallthrough,
  };
}

function metadata(f: Pick<FlagRow, 'name' | 'description' | 'variants' | 'client_side'>) {
  return {
    name: f.name,
    description: f.description,
    variants: f.variants,
    clientSide: f.client_side,
  };
}

function uniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

async function environmentsOf(db: Db, projectId: string) {
  return db
    .selectFrom('environments')
    .select(['id', 'key'])
    .where('project_id', '=', projectId)
    .orderBy('id')
    .execute();
}

/**
 * Locks the flag row. Metadata writers take it exclusively; targeting writers
 * share it, so edits to two environments of one flag run side by side while
 * the variants they are validated against cannot change underneath them.
 */
async function lockFlag(
  trx: Db,
  projectId: string,
  key: string,
  mode: 'update' | 'share' = 'update',
): Promise<FlagRow> {
  const query = trx
    .selectFrom('flags')
    .selectAll()
    .where('project_id', '=', projectId)
    .where('key', '=', key);
  const row = await (mode === 'update' ? query.forUpdate() : query.forShare()).executeTakeFirst();
  if (row === undefined) throw notFound(`flag "${key}"`);
  return row;
}

export function versionConflict(what: string, current: number): AppError {
  return new AppError(
    'version_conflict',
    `${what} was changed by someone else; reload and try again`,
    {
      currentVersion: current,
    },
  );
}

/**
 * Applies `mutate` to the environment's current ruleset and validates the
 * result as a whole. This is where cross-flag problems surface: a removed
 * variant still used as a prerequisite, a segment that no longer exists, a
 * prerequisite cycle.
 */
export async function validateCandidate(
  trx: Db,
  environmentId: string,
  mutate: (ruleset: Ruleset) => void,
): Promise<void> {
  const ruleset = await loadRuleset(trx, environmentId);
  mutate(ruleset);
  const result = validateRuleset(ruleset);
  if (!result.ok) {
    throw new AppError(
      'invalid_argument',
      `this change would leave the ${ruleset.environment} ruleset invalid`,
      result.issues,
    );
  }
}

export async function listFlags(
  db: Db,
  projectId: string,
  environmentId: string,
  filter: {
    q?: string | undefined;
    status?: FlagStatus | undefined;
    type?: Flag['type'] | undefined;
    limit: number;
    after?: string | undefined;
  },
  now: Date,
): Promise<FlagSummary[]> {
  let query = lifecycleQuery(db)
    .select([
      'flags.key',
      'flags.name',
      'flags.description',
      'flags.type',
      'flags.client_side',
      'flags.version',
      'flag_configs.version as targeting_version',
      sql<Date>`greatest(flags.updated_at, flag_configs.updated_at)`.as('updated_at'),
      STATUS.as('status'),
      sql<number>`jsonb_array_length(flag_configs.rules)`.as('rule_count'),
    ])
    .where('flags.project_id', '=', projectId)
    .where('flag_configs.environment_id', '=', environmentId);
  if (filter.q !== undefined && filter.q !== '') {
    const like = `%${filter.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    query = query.where((eb) =>
      eb.or([eb('flags.key', 'ilike', like), eb('flags.name', 'ilike', like)]),
    );
  }
  if (filter.status === undefined) query = query.where('flags.archived_at', 'is', null);
  else query = query.where(STATUS, '=', filter.status);
  if (filter.type !== undefined) query = query.where('flags.type', '=', filter.type);
  if (filter.after !== undefined) query = query.where('flags.key', '>', filter.after);
  const rows = await query.orderBy('flags.key').limit(filter.limit).execute();
  return rows.map((r) => ({
    key: r.key,
    name: r.name,
    description: r.description,
    type: r.type,
    clientSide: r.client_side,
    version: r.version,
    targetingVersion: r.targeting_version,
    updatedAt: r.updated_at.toISOString(),
    status: r.status,
    ruleCount: r.rule_count,
    lifecycle: lifecycleFromRow(r, now),
    lastEvaluatedAt: r.last_evaluated_at?.toISOString() ?? null,
  }));
}

export async function getFlag(db: Db, projectId: string, key: string): Promise<FlagView> {
  const flag = await db
    .selectFrom('flags')
    .selectAll()
    .where('project_id', '=', projectId)
    .where('key', '=', key)
    .executeTakeFirst();
  if (flag === undefined) throw notFound(`flag "${key}"`);
  const configs = await db
    .selectFrom('flag_configs')
    .innerJoin('environments', 'environments.id', 'flag_configs.environment_id')
    .select([
      'environments.key as env',
      'flag_configs.enabled',
      'flag_configs.off_variant',
      'flag_configs.prerequisites',
      'flag_configs.rules',
      'flag_configs.fallthrough',
      'flag_configs.version',
      'flag_configs.updated_at',
    ])
    .where('flag_configs.flag_id', '=', flag.id)
    .orderBy('environments.created_at')
    .execute();
  return {
    key: flag.key,
    name: flag.name,
    description: flag.description,
    type: flag.type,
    variants: flag.variants,
    clientSide: flag.client_side,
    salt: flag.salt,
    archived: flag.archived_at !== null,
    version: flag.version,
    createdAt: flag.created_at.toISOString(),
    updatedAt: new Date(
      Math.max(flag.updated_at.getTime(), ...configs.map((c) => c.updated_at.getTime())),
    ).toISOString(),
    environments: Object.fromEntries(
      configs.map((c) => [
        c.env,
        { ...configView(c), version: c.version, updatedAt: c.updated_at.toISOString() },
      ]),
    ),
  };
}

export async function createFlag(scope: Scope, input: FlagInput): Promise<FlagView> {
  const variants = input.variants ?? (input.type === 'boolean' ? BOOLEAN_VARIANTS : []);
  const initial = defaultEnvConfig(variants);
  try {
    await scope.db.transaction().execute(async (trx) => {
      const envs = await environmentsOf(trx, scope.project.id);
      await lockEnvironments(
        trx,
        envs.map((e) => e.id),
      );
      const flag = await trx
        .insertInto('flags')
        .values({
          project_id: scope.project.id,
          key: input.key,
          name: input.name,
          description: input.description ?? '',
          type: input.type,
          variants: JSON.stringify(variants),
          salt: input.key,
          client_side: input.clientSide ?? false,
          archived_at: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const asRuleset = toFlag(flag, { ...configColumnsView(initial), version: 1 });
      for (const env of envs) {
        await validateCandidate(trx, env.id, (rs) => {
          rs.flags[flag.key] = asRuleset;
        });
        await trx
          .insertInto('flag_configs')
          .values({ flag_id: flag.id, environment_id: env.id, ...configColumns(initial) })
          .execute();
        await recordChange(trx, env.id, 'flag', flag.key, scope.retention);
      }
      if (envs.length === 0) {
        // No environment to validate against: check the flag on its own.
        const result = validateRuleset({
          environment: 'none',
          version: 0,
          flags: { [flag.key]: asRuleset },
          segments: {},
        });
        if (!result.ok) throw new AppError('invalid_argument', 'invalid flag', result.issues);
      }
      await recordAudit(trx, {
        projectId: scope.project.id,
        actor: scope.actor,
        action: 'flag.create',
        targetType: 'flag',
        targetKey: flag.key,
        after: { ...metadata(flag), type: flag.type },
        snapshot: 'flag',
      });
    });
  } catch (err) {
    if (uniqueViolation(err)) throw new AppError('already_exists', `flag "${input.key}" exists`);
    throw err;
  }
  return getFlag(scope.db, scope.project.id, input.key);
}

function configColumnsView(c: EnvConfig) {
  return {
    enabled: c.enabled,
    off_variant: c.offVariant,
    prerequisites: c.prerequisites,
    rules: c.rules,
    fallthrough: c.fallthrough,
  };
}

export async function updateFlag(
  scope: Scope,
  key: string,
  patch: FlagPatch,
  action = 'flag.update',
): Promise<FlagView> {
  await scope.db.transaction().execute(async (trx) => {
    const envs = await environmentsOf(trx, scope.project.id);
    await lockEnvironments(
      trx,
      envs.map((e) => e.id),
    );
    const before = await lockFlag(trx, scope.project.id, key);
    if (before.version !== patch.version) throw versionConflict(`flag "${key}"`, before.version);
    const set: Partial<{
      name: string;
      description: string;
      variants: string;
      client_side: boolean;
    }> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.variants !== undefined) set.variants = JSON.stringify(patch.variants);
    if (patch.clientSide !== undefined) set.client_side = patch.clientSide;
    const after = await trx
      .updateTable('flags')
      .set({ ...set, version: before.version + 1, updated_at: new Date() })
      .where('id', '=', before.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    if (after.archived_at === null) {
      const configs = await trx
        .selectFrom('flag_configs')
        .selectAll()
        .where('flag_id', '=', after.id)
        .execute();
      for (const config of configs) {
        const asRuleset = toFlag(after, config);
        await validateCandidate(trx, config.environment_id, (rs) => {
          rs.flags[key] = asRuleset;
        });
        await recordChange(trx, config.environment_id, 'flag', key, scope.retention);
      }
    }
    await recordAudit(trx, {
      projectId: scope.project.id,
      actor: scope.actor,
      action,
      targetType: 'flag',
      targetKey: key,
      before: metadata(before),
      after: metadata(after),
      snapshot: 'flag',
    });
  });
  return getFlag(scope.db, scope.project.id, key);
}

/**
 * Replaces a flag's configuration in one environment. `expectedVersion` is
 * the targeting version of that environment the editor loaded; undefined
 * skips the check (kill switch, scheduled changes). Other environments and
 * the flag's metadata have their own versions, so changes there never make
 * this edit conflict.
 */
export async function writeConfig(
  trx: Db,
  scope: Scope,
  env: { id: string; key: string },
  key: string,
  next: (current: EnvConfig) => EnvConfig,
  expectedVersion: number | undefined,
  action: string,
): Promise<void> {
  // The environment lock serialises every writer of this flag_configs row.
  await lockEnvironments(trx, [env.id]);
  const flag = await lockFlag(trx, scope.project.id, key, 'share');
  if (flag.archived_at !== null) {
    throw new AppError('invalid_argument', `flag "${key}" is archived; restore it first`);
  }
  const row = await trx
    .selectFrom('flag_configs')
    .selectAll()
    .where('flag_id', '=', flag.id)
    .where('environment_id', '=', env.id)
    .executeTakeFirstOrThrow();
  if (expectedVersion !== undefined && row.version !== expectedVersion) {
    throw versionConflict(`targeting of flag "${key}" in ${env.key}`, row.version);
  }
  const before = configView(row);
  const after = next(before);
  const version = row.version + 1;
  const asRuleset = toFlag(flag, { ...configColumnsView(after), version });
  await validateCandidate(trx, env.id, (rs) => {
    rs.flags[key] = asRuleset;
  });
  await trx
    .updateTable('flag_configs')
    .set({ ...configColumns(after), version, updated_at: new Date() })
    .where('flag_id', '=', flag.id)
    .where('environment_id', '=', env.id)
    .execute();
  await recordChange(trx, env.id, 'flag', key, scope.retention);
  await recordAudit(trx, {
    projectId: scope.project.id,
    environmentId: env.id,
    actor: scope.actor,
    action,
    targetType: 'flag',
    targetKey: key,
    before,
    after,
    snapshot: 'targeting',
  });
  if (before.enabled && !after.enabled) {
    await pauseForKillSwitch(trx, scope, env, { id: flag.id, key }, new Date());
  }
}

/**
 * Pauses the active plans of a flag whose kill switch was just turned off.
 * Called inside the write that turned it off, with the environment locked; a
 * plan the scheduler holds is skipped rather than waited for, because the
 * scheduler reads the flag after taking the same lock and pauses it itself.
 */
export async function pauseForKillSwitch(
  trx: Db,
  scope: Scope,
  env: { id: string },
  flag: { id: string; key: string },
  now: Date,
): Promise<void> {
  const paused = await trx
    .updateTable('rollout_plans')
    .set({ status: 'paused', paused_reason: 'kill_switch', next_at: null, updated_at: now })
    .where('id', 'in', (qb) =>
      qb
        .selectFrom('rollout_plans')
        .select('id')
        .where('flag_id', '=', flag.id)
        .where('environment_id', '=', env.id)
        .where('status', '=', 'active')
        .forUpdate()
        .skipLocked(),
    )
    .returning(['id', 'step'])
    .execute();
  for (const p of paused) {
    await recordAudit(trx, {
      projectId: scope.project.id,
      environmentId: env.id,
      actor: scope.actor,
      action: 'flag.rollout.pause',
      targetType: 'flag',
      targetKey: flag.key,
      after: { plan: p.id, step: p.step, reason: 'kill_switch' },
    });
  }
}

/**
 * Refuses a direct targeting change in an environment that takes them only
 * through approved change requests. Reads the setting inside the writer's
 * transaction, after the environment lock, so turning protection on can't
 * race an edit already in flight.
 */
export async function requireUnprotected(
  trx: Db,
  env: { id: string; key: string },
  what: string,
): Promise<void> {
  const row = await trx
    .selectFrom('environments')
    .select('required_approvals')
    .where('id', '=', env.id)
    .executeTakeFirstOrThrow();
  if (row.required_approvals > 0) {
    throw new AppError(
      'permission_denied',
      `${env.key} is protected: ${what} go through an approved change request`,
      { requiredApprovals: row.required_approvals },
    );
  }
}

/**
 * Refuses a change without the reason or ticket link its environment
 * requires. Change requests pass their title as the reason, so only a link
 * can be missing there.
 */
export async function requireNote(
  trx: Db,
  env: { id: string; key: string },
  note: ChangeNote | undefined,
): Promise<void> {
  const row = await trx
    .selectFrom('environments')
    .select(['require_reason', 'require_link'])
    .where('id', '=', env.id)
    .executeTakeFirstOrThrow();
  const needReason = row.require_reason && (note?.reason ?? null) === null;
  const needLink = row.require_link && (note?.link ?? null) === null;
  if (!needReason && !needLink) return;
  const issues = [
    ...(needReason ? [{ path: 'header.flagship-reason', message: `required in ${env.key}` }] : []),
    ...(needLink ? [{ path: 'header.flagship-link', message: `required in ${env.key}` }] : []),
  ];
  const what =
    needReason && needLink
      ? 'a reason and a ticket link'
      : needReason
        ? 'a reason'
        : 'a ticket link';
  throw new AppError('invalid_argument', `changes in ${env.key} need ${what}`, issues);
}

export async function updateConfig(
  scope: Scope,
  env: { id: string; key: string },
  key: string,
  config: EnvConfig,
  expectedVersion: number,
): Promise<FlagView> {
  await scope.db.transaction().execute(async (trx) => {
    await lockEnvironments(trx, [env.id]);
    await requireUnprotected(trx, env, 'targeting changes');
    await requireNote(trx, env, scope.actor.note);
    await writeConfig(trx, scope, env, key, () => config, expectedVersion, 'flag.config.update');
  });
  return getFlag(scope.db, scope.project.id, key);
}

/**
 * The emergency off switch. No version is required: flipping one boolean is
 * safe to apply on top of whatever else changed, and whoever is reaching for
 * it should not have to reload first. It still bumps the environment's
 * targeting version, so an older draft there gets a conflict instead of
 * silently turning the flag back on.
 */
export async function setKillSwitch(
  scope: Scope,
  env: { id: string; key: string },
  key: string,
  enabled: boolean,
): Promise<FlagView> {
  await scope.db.transaction().execute(async (trx) => {
    await requireNote(trx, env, scope.actor.note);
    await writeConfig(
      trx,
      scope,
      env,
      key,
      (c) => ({ ...c, enabled }),
      undefined,
      'flag.kill_switch',
    );
  });
  return getFlag(scope.db, scope.project.id, key);
}

async function setArchived(
  scope: Scope,
  key: string,
  archive: boolean,
  version: number,
): Promise<FlagView> {
  await scope.db.transaction().execute(async (trx) => {
    const envs = await environmentsOf(trx, scope.project.id);
    await lockEnvironments(
      trx,
      envs.map((e) => e.id),
    );
    const before = await lockFlag(trx, scope.project.id, key);
    if (before.version !== version) throw versionConflict(`flag "${key}"`, before.version);
    if ((before.archived_at !== null) === archive) {
      throw new AppError(
        'invalid_argument',
        `flag "${key}" is already ${archive ? 'archived' : 'active'}`,
      );
    }
    const after = await trx
      .updateTable('flags')
      .set({
        archived_at: archive ? new Date() : null,
        version: before.version + 1,
        updated_at: new Date(),
      })
      .where('id', '=', before.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    const configs = await trx
      .selectFrom('flag_configs')
      .selectAll()
      .where('flag_id', '=', after.id)
      .execute();
    for (const config of configs) {
      const asRuleset = toFlag(after, config);
      await validateCandidate(trx, config.environment_id, (rs) => {
        if (archive) Reflect.deleteProperty(rs.flags, key);
        else rs.flags[key] = asRuleset;
      });
      await recordChange(trx, config.environment_id, 'flag', key, scope.retention);
    }
    if (archive) {
      await trx
        .updateTable('scheduled_changes')
        .set({ status: 'cancelled', finished_at: new Date(), error: 'flag was archived' })
        .where('flag_id', '=', after.id)
        .where('status', '=', 'pending')
        .execute();
      // A plan the scheduler holds is skipped, not waited for: the scheduler
      // takes the environment lock next, sees the archive and cancels it.
      await trx
        .updateTable('rollout_plans')
        .set({
          status: 'cancelled',
          next_at: null,
          paused_reason: null,
          error: 'flag was archived',
          finished_at: new Date(),
          updated_at: new Date(),
        })
        .where('id', 'in', (qb) =>
          qb
            .selectFrom('rollout_plans')
            .select('id')
            .where('flag_id', '=', after.id)
            .where('status', 'in', ['active', 'paused'])
            .forUpdate()
            .skipLocked(),
        )
        .execute();
      await stopExperimentsForArchive(trx, after.id, new Date());
    }
    await recordAudit(trx, {
      projectId: scope.project.id,
      actor: scope.actor,
      action: archive ? 'flag.archive' : 'flag.restore',
      targetType: 'flag',
      targetKey: key,
      before: { archived: !archive },
      after: { archived: archive },
    });
  });
  return getFlag(scope.db, scope.project.id, key);
}

export const archiveFlag = (scope: Scope, key: string, version: number) =>
  setArchived(scope, key, true, version);
export const restoreFlag = (scope: Scope, key: string, version: number) =>
  setArchived(scope, key, false, version);
