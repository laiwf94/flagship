import type { Segment } from '@flagship/core';
import type { Db } from '../db/database.js';
import { AppError, notFound } from '../errors.js';
import { recordAudit } from './audit.js';
import { validateCandidate, versionConflict, type Scope } from './flags.js';
import { lockEnvironments, recordChange, toSegment, type SegmentRow } from './rulesets.js';

export interface SegmentView {
  key: string;
  name: string;
  description: string;
  included: string[];
  excluded: string[];
  rules: Segment['rules'];
  version: number;
  updatedAt: string;
}

export interface SegmentInput {
  key: string;
  name: string;
  description?: string | undefined;
  included: string[];
  excluded: string[];
  rules: Segment['rules'];
}

function view(r: SegmentRow): SegmentView {
  return {
    key: r.key,
    name: r.name,
    description: r.description,
    included: r.included,
    excluded: r.excluded,
    rules: r.rules,
    version: r.version,
    updatedAt: r.updated_at.toISOString(),
  };
}

function content(r: SegmentRow | SegmentView) {
  return {
    name: r.name,
    description: r.description,
    included: r.included,
    excluded: r.excluded,
    rules: r.rules,
  };
}

function uniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

export async function listSegments(db: Db, environmentId: string): Promise<SegmentView[]> {
  const rows = await db
    .selectFrom('segments')
    .selectAll()
    .where('environment_id', '=', environmentId)
    .orderBy('key')
    .execute();
  return rows.map(view);
}

async function lockSegment(trx: Db, environmentId: string, key: string): Promise<SegmentRow> {
  const row = await trx
    .selectFrom('segments')
    .selectAll()
    .where('environment_id', '=', environmentId)
    .where('key', '=', key)
    .forUpdate()
    .executeTakeFirst();
  if (row === undefined) throw notFound(`segment "${key}"`);
  return row;
}

export async function getSegment(db: Db, environmentId: string, key: string): Promise<SegmentView> {
  const row = await db
    .selectFrom('segments')
    .selectAll()
    .where('environment_id', '=', environmentId)
    .where('key', '=', key)
    .executeTakeFirst();
  if (row === undefined) throw notFound(`segment "${key}"`);
  return view(row);
}

export async function createSegment(
  scope: Scope,
  env: { id: string },
  input: SegmentInput,
): Promise<SegmentView> {
  try {
    return await scope.db.transaction().execute(async (trx) => {
      await lockEnvironments(trx, [env.id]);
      const row = await trx
        .insertInto('segments')
        .values({
          environment_id: env.id,
          key: input.key,
          name: input.name,
          description: input.description ?? '',
          included: JSON.stringify(input.included),
          excluded: JSON.stringify(input.excluded),
          rules: JSON.stringify(input.rules),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const segment = toSegment(row);
      await validateCandidate(trx, env.id, () => undefined);
      await recordChange(trx, env.id, 'segment', row.key, segment, scope.retention);
      await recordAudit(trx, {
        projectId: scope.project.id,
        environmentId: env.id,
        actor: scope.actor,
        action: 'segment.create',
        targetType: 'segment',
        targetKey: row.key,
        after: content(row),
      });
      return view(row);
    });
  } catch (err) {
    if (uniqueViolation(err)) throw new AppError('already_exists', `segment "${input.key}" exists`);
    throw err;
  }
}

export async function updateSegment(
  scope: Scope,
  env: { id: string },
  key: string,
  input: Omit<SegmentInput, 'key'>,
  version: number,
): Promise<SegmentView> {
  return scope.db.transaction().execute(async (trx) => {
    await lockEnvironments(trx, [env.id]);
    const before = await lockSegment(trx, env.id, key);
    if (before.version !== version) throw versionConflict(`segment "${key}"`, before.version);
    const after = await trx
      .updateTable('segments')
      .set({
        name: input.name,
        description: input.description ?? '',
        included: JSON.stringify(input.included),
        excluded: JSON.stringify(input.excluded),
        rules: JSON.stringify(input.rules),
        version: before.version + 1,
        updated_at: new Date(),
      })
      .where('id', '=', before.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await validateCandidate(trx, env.id, () => undefined);
    await recordChange(trx, env.id, 'segment', key, toSegment(after), scope.retention);
    await recordAudit(trx, {
      projectId: scope.project.id,
      environmentId: env.id,
      actor: scope.actor,
      action: 'segment.update',
      targetType: 'segment',
      targetKey: key,
      before: content(before),
      after: content(after),
    });
    return view(after);
  });
}

export async function deleteSegment(
  scope: Scope,
  env: { id: string },
  key: string,
  version: number,
): Promise<void> {
  await scope.db.transaction().execute(async (trx) => {
    await lockEnvironments(trx, [env.id]);
    const before = await lockSegment(trx, env.id, key);
    if (before.version !== version) throw versionConflict(`segment "${key}"`, before.version);
    await validateCandidate(trx, env.id, (rs) => {
      Reflect.deleteProperty(rs.segments, key);
    });
    await trx.deleteFrom('segments').where('id', '=', before.id).execute();
    await recordChange(trx, env.id, 'segment', key, null, scope.retention);
    await recordAudit(trx, {
      projectId: scope.project.id,
      environmentId: env.id,
      actor: scope.actor,
      action: 'segment.delete',
      targetType: 'segment',
      targetKey: key,
      before: content(before),
    });
  });
}
