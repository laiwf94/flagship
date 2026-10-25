import { validateRuleset, type Flag, type Ruleset, type Variant } from '@flagship/core';
import { sql } from 'kysely';
import type { Db } from '../db/database.js';
import { AppError, notFound } from '../errors.js';
import { recordAudit, type Actor } from './audit.js';
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
  version: number;
  createdAt: string;
  updatedAt: string;
  environments: Record<string, EnvConfig & { updatedAt: string }>;
}

export interface FlagSummary {
  key: string;
  name: string;
  description: string;
  type: Flag['type'];
  clientSide: boolean;
  version: number;
  updatedAt: string;
  status: FlagStatus;
  ruleCount: number;
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

function configView(
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

async function lockFlag(trx: Db, projectId: string, key: string): Promise<FlagRow> {
  const row = await trx
    .selectFrom('flags')
    .selectAll()
    .where('project_id', '=', projectId)
    .where('key', '=', key)
    .forUpdate()
    .executeTakeFirst();
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

async function touchFlag(trx: Db, flag: FlagRow): Promise<FlagRow> {
  return trx
    .updateTable('flags')
    .set({ version: flag.version + 1, updated_at: new Date() })
    .where('id', '=', flag.id)
    .returningAll()
    .executeTakeFirstOrThrow();
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
): Promise<FlagSummary[]> {
  let query = db
    .selectFrom('flags')
    .innerJoin('flag_configs', 'flag_configs.flag_id', 'flags.id')
    .select([
      'flags.key',
      'flags.name',
      'flags.description',
      'flags.type',
      'flags.client_side',
      'flags.version',
      'flags.updated_at',
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
    updatedAt: r.updated_at.toISOString(),
    status: r.status,
    ruleCount: r.rule_count,
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
    updatedAt: flag.updated_at.toISOString(),
    environments: Object.fromEntries(
      configs.map((c) => [c.env, { ...configView(c), updatedAt: c.updated_at.toISOString() }]),
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
      const asRuleset = toFlag(flag, configColumnsView(initial));
      for (const env of envs) {
        await validateCandidate(trx, env.id, (rs) => {
          rs.flags[flag.key] = asRuleset;
        });
        await trx
          .insertInto('flag_configs')
          .values({ flag_id: flag.id, environment_id: env.id, ...configColumns(initial) })
          .execute();
        await recordChange(trx, env.id, 'flag', flag.key, asRuleset, scope.retention);
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

export async function updateFlag(scope: Scope, key: string, patch: FlagPatch): Promise<FlagView> {
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
        await recordChange(trx, config.environment_id, 'flag', key, asRuleset, scope.retention);
      }
    }
    await recordAudit(trx, {
      projectId: scope.project.id,
      actor: scope.actor,
      action: 'flag.update',
      targetType: 'flag',
      targetKey: key,
      before: metadata(before),
      after: metadata(after),
    });
  });
  return getFlag(scope.db, scope.project.id, key);
}

/**
 * Replaces a flag's configuration in one environment. `expectedVersion` is
 * the flag version the editor loaded; undefined skips the check (kill switch,
 * scheduled changes).
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
  await lockEnvironments(trx, [env.id]);
  const flag = await lockFlag(trx, scope.project.id, key);
  if (flag.archived_at !== null) {
    throw new AppError('invalid_argument', `flag "${key}" is archived; restore it first`);
  }
  if (expectedVersion !== undefined && flag.version !== expectedVersion) {
    throw versionConflict(`flag "${key}"`, flag.version);
  }
  const row = await trx
    .selectFrom('flag_configs')
    .selectAll()
    .where('flag_id', '=', flag.id)
    .where('environment_id', '=', env.id)
    .executeTakeFirstOrThrow();
  const before = configView(row);
  const after = next(before);
  const touched = await touchFlag(trx, flag);
  const asRuleset = toFlag(touched, configColumnsView(after));
  await validateCandidate(trx, env.id, (rs) => {
    rs.flags[key] = asRuleset;
  });
  await trx
    .updateTable('flag_configs')
    .set({ ...configColumns(after), updated_at: new Date() })
    .where('flag_id', '=', flag.id)
    .where('environment_id', '=', env.id)
    .execute();
  await recordChange(trx, env.id, 'flag', key, asRuleset, scope.retention);
  await recordAudit(trx, {
    projectId: scope.project.id,
    environmentId: env.id,
    actor: scope.actor,
    action,
    targetType: 'flag',
    targetKey: key,
    before,
    after,
  });
}

export async function updateConfig(
  scope: Scope,
  env: { id: string; key: string },
  key: string,
  config: EnvConfig,
  expectedVersion: number,
): Promise<FlagView> {
  await scope.db
    .transaction()
    .execute((trx) =>
      writeConfig(trx, scope, env, key, () => config, expectedVersion, 'flag.config.update'),
    );
  return getFlag(scope.db, scope.project.id, key);
}

/**
 * The emergency off switch. No version is required: flipping one boolean is
 * safe to apply on top of whatever else changed, and whoever is reaching for
 * it should not have to reload first.
 */
export async function setKillSwitch(
  scope: Scope,
  env: { id: string; key: string },
  key: string,
  enabled: boolean,
): Promise<FlagView> {
  await scope.db
    .transaction()
    .execute((trx) =>
      writeConfig(trx, scope, env, key, (c) => ({ ...c, enabled }), undefined, 'flag.kill_switch'),
    );
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
      await recordChange(
        trx,
        config.environment_id,
        'flag',
        key,
        archive ? null : asRuleset,
        scope.retention,
      );
    }
    if (archive) {
      await trx
        .updateTable('scheduled_changes')
        .set({ status: 'cancelled', finished_at: new Date(), error: 'flag was archived' })
        .where('flag_id', '=', after.id)
        .where('status', '=', 'pending')
        .execute();
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
