import type { Db } from '../db/database.js';
import { AppError, notFound } from '../errors.js';
import { recordAudit, type Actor } from './audit.js';
import { configColumns, defaultEnvConfig } from './flags.js';

export interface EnvironmentView {
  key: string;
  name: string;
}

export interface EnvironmentSettings extends EnvironmentView {
  /** Approvals a change request needs; above zero, targeting changes only go through one. */
  requiredApprovals: number;
  /** Every change here must give a reason. */
  requireReason: boolean;
  /** Every change here must give a ticket link. */
  requireLink: boolean;
}

export interface ProjectView {
  key: string;
  name: string;
  environments: EnvironmentSettings[];
}

export interface ProjectRow {
  id: string;
  key: string;
  name: string;
}

export interface EnvironmentRow {
  id: string;
  key: string;
  name: string;
  project_id: string;
}

const UNPROTECTED = { requiredApprovals: 0, requireReason: false, requireLink: false };

export const DEFAULT_ENVIRONMENTS: EnvironmentView[] = [
  { key: 'development', name: 'Development' },
  { key: 'production', name: 'Production' },
];

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

export async function getProject(db: Db, key: string): Promise<ProjectRow> {
  const row = await db
    .selectFrom('projects')
    .select(['id', 'key', 'name'])
    .where('key', '=', key)
    .executeTakeFirst();
  if (row === undefined) throw notFound(`project "${key}"`);
  return row;
}

export async function getEnvironment(
  db: Db,
  projectId: string,
  key: string,
): Promise<EnvironmentRow> {
  const row = await db
    .selectFrom('environments')
    .select(['id', 'key', 'name', 'project_id'])
    .where('project_id', '=', projectId)
    .where('key', '=', key)
    .executeTakeFirst();
  if (row === undefined) throw notFound(`environment "${key}"`);
  return row;
}

export async function listProjects(db: Db): Promise<ProjectView[]> {
  const projects = await db
    .selectFrom('projects')
    .select(['id', 'key', 'name'])
    .orderBy('key')
    .execute();
  const envs = await db
    .selectFrom('environments')
    .select(['project_id', 'key', 'name', 'required_approvals', 'require_reason', 'require_link'])
    .orderBy('created_at')
    .orderBy('key')
    .execute();
  return projects.map((p) => ({
    key: p.key,
    name: p.name,
    environments: envs
      .filter((e) => e.project_id === p.id)
      .map((e) => ({
        key: e.key,
        name: e.name,
        requiredApprovals: e.required_approvals,
        requireReason: e.require_reason,
        requireLink: e.require_link,
      })),
  }));
}

async function insertEnvironment(
  trx: Db,
  projectId: string,
  env: EnvironmentView,
): Promise<string> {
  const row = await trx
    .insertInto('environments')
    .values({ project_id: projectId, key: env.key, name: env.name })
    .returning('id')
    .executeTakeFirstOrThrow();
  const flags = await trx
    .selectFrom('flags')
    .select(['id', 'variants'])
    .where('project_id', '=', projectId)
    .execute();
  if (flags.length > 0) {
    await trx
      .insertInto('flag_configs')
      .values(
        flags.map((f) => ({
          flag_id: f.id,
          environment_id: row.id,
          ...configColumns(defaultEnvConfig(f.variants)),
        })),
      )
      .execute();
  }
  return row.id;
}

export async function createProject(
  db: Db,
  input: { key: string; name: string; environments?: EnvironmentView[] | undefined },
  actor: Actor,
): Promise<ProjectView> {
  const environments = input.environments ?? DEFAULT_ENVIRONMENTS;
  try {
    return await db.transaction().execute(async (trx) => {
      const project = await trx
        .insertInto('projects')
        .values({ key: input.key, name: input.name })
        .returning('id')
        .executeTakeFirstOrThrow();
      for (const env of environments) await insertEnvironment(trx, project.id, env);
      const view = {
        key: input.key,
        name: input.name,
        environments: environments.map((e) => ({ ...e, ...UNPROTECTED })),
      };
      await recordAudit(trx, {
        projectId: project.id,
        actor,
        action: 'project.create',
        targetType: 'project',
        targetKey: input.key,
        after: view,
      });
      return view;
    });
  } catch (err) {
    if (isUniqueViolation(err))
      throw new AppError('already_exists', `project "${input.key}" exists`);
    throw err;
  }
}

export async function createEnvironment(
  db: Db,
  projectKey: string,
  env: EnvironmentView,
  actor: Actor,
): Promise<EnvironmentSettings> {
  const project = await getProject(db, projectKey);
  try {
    return await db.transaction().execute(async (trx) => {
      const id = await insertEnvironment(trx, project.id, env);
      await recordAudit(trx, {
        projectId: project.id,
        environmentId: id,
        actor,
        action: 'environment.create',
        targetType: 'environment',
        targetKey: env.key,
        after: env,
      });
      return { ...env, ...UNPROTECTED };
    });
  } catch (err) {
    if (isUniqueViolation(err))
      throw new AppError('already_exists', `environment "${env.key}" exists`);
    throw err;
  }
}

/**
 * Sets how many approvals a change request needs in an environment. Zero
 * turns protection off; one or more makes change requests the only way to
 * change targeting there. Takes the environment lock, so it waits for edits
 * in flight and every later edit sees the new setting.
 */
export async function setRequiredApprovals(
  db: Db,
  env: { id: string; projectId: string; key: string },
  requiredApprovals: number,
  actor: Actor,
): Promise<EnvironmentSettings> {
  return db.transaction().execute(async (trx) => {
    const before = await trx
      .selectFrom('environments')
      .select(['key', 'name', 'required_approvals', 'require_reason', 'require_link'])
      .where('id', '=', env.id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    await trx
      .updateTable('environments')
      .set({ required_approvals: requiredApprovals })
      .where('id', '=', env.id)
      .execute();
    await recordAudit(trx, {
      projectId: env.projectId,
      environmentId: env.id,
      actor,
      action: 'environment.approvals',
      targetType: 'environment',
      targetKey: env.key,
      before: { requiredApprovals: before.required_approvals },
      after: { requiredApprovals },
    });
    return {
      key: before.key,
      name: before.name,
      requiredApprovals,
      requireReason: before.require_reason,
      requireLink: before.require_link,
    };
  });
}

/**
 * Sets whether every change in an environment must give a reason, a ticket
 * link or both. Takes the environment row lock like the approvals setting,
 * so a write already checking the old setting finishes first.
 */
export async function setChangeNotes(
  db: Db,
  env: { id: string; projectId: string; key: string },
  settings: { requireReason: boolean; requireLink: boolean },
  actor: Actor,
): Promise<EnvironmentSettings> {
  return db.transaction().execute(async (trx) => {
    const before = await trx
      .selectFrom('environments')
      .select(['key', 'name', 'required_approvals', 'require_reason', 'require_link'])
      .where('id', '=', env.id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    await trx
      .updateTable('environments')
      .set({ require_reason: settings.requireReason, require_link: settings.requireLink })
      .where('id', '=', env.id)
      .execute();
    await recordAudit(trx, {
      projectId: env.projectId,
      environmentId: env.id,
      actor,
      action: 'environment.change_notes',
      targetType: 'environment',
      targetKey: env.key,
      before: { requireReason: before.require_reason, requireLink: before.require_link },
      after: settings,
    });
    return {
      key: before.key,
      name: before.name,
      requiredApprovals: before.required_approvals,
      ...settings,
    };
  });
}

/** Gives a fresh install something to click on: one project, two environments. */
export async function bootstrapProject(db: Db, actor: Actor): Promise<void> {
  const existing = await db
    .selectFrom('projects')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirstOrThrow();
  if (existing.n > 0) return;
  try {
    await createProject(db, { key: 'default', name: 'Default project' }, actor);
  } catch (err) {
    if (!(err instanceof AppError && err.code === 'already_exists')) throw err;
  }
}
