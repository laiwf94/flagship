import type { Db } from '../db/database.js';
import { AppError, notFound } from '../errors.js';
import { recordAudit, type Actor } from './audit.js';

export interface EnvironmentView {
  key: string;
  name: string;
}

export interface ProjectView {
  key: string;
  name: string;
  environments: EnvironmentView[];
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
    .select(['project_id', 'key', 'name'])
    .orderBy('created_at')
    .orderBy('key')
    .execute();
  return projects.map((p) => ({
    key: p.key,
    name: p.name,
    environments: envs
      .filter((e) => e.project_id === p.id)
      .map((e) => ({ key: e.key, name: e.name })),
  }));
}

/**
 * The configuration a flag gets in an environment it has never been edited in:
 * off, serving its "off" variant (false for boolean flags, else the first).
 */
export function defaultConfig(variants: readonly { key: string; value: unknown }[]): {
  enabled: boolean;
  off_variant: string;
  prerequisites: string;
  rules: string;
  fallthrough: string;
} {
  const off = (variants.find((v) => v.value === false) ?? variants[0])?.key ?? 'off';
  return {
    enabled: false,
    off_variant: off,
    prerequisites: '[]',
    rules: '[]',
    fallthrough: JSON.stringify({ variant: off }),
  };
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
        flags.map((f) => ({ flag_id: f.id, environment_id: row.id, ...defaultConfig(f.variants) })),
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
      const view = { key: input.key, name: input.name, environments };
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
): Promise<EnvironmentView> {
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
      return env;
    });
  } catch (err) {
    if (isUniqueViolation(err))
      throw new AppError('already_exists', `environment "${env.key}" exists`);
    throw err;
  }
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
