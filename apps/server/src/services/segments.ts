import type { Segment } from '@flagship/core';
import type { Db } from '../db/database.js';
import { AppError, notFound } from '../errors.js';
import { recordAudit } from './audit.js';
import {
  requireNote,
  requireUnprotected,
  validateCandidate,
  versionConflict,
  type Scope,
} from './flags.js';
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

/** What a segment is, without its key and bookkeeping: what a change request proposes. */
export interface SegmentContent {
  name: string;
  description: string;
  included: string[];
  excluded: string[];
  rules: Segment['rules'];
}

export function content(r: SegmentContent): SegmentContent {
  return {
    name: r.name,
    description: r.description,
    included: r.included,
    excluded: r.excluded,
    rules: r.rules,
  };
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

/**
 * A segment as it is now: its version, or 0 when there is none, and its
 * content, or null. Writers hold the environment lock, so inside one of
 * their transactions this is the live state until it commits.
 */
export async function liveSegment(
  db: Db,
  environmentId: string,
  key: string,
): Promise<{ version: number; content: SegmentContent | null }> {
  const row = await db
    .selectFrom('segments')
    .selectAll()
    .where('environment_id', '=', environmentId)
    .where('key', '=', key)
    .executeTakeFirst();
  return row === undefined
    ? { version: 0, content: null }
    : { version: row.version, content: content(row) };
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

/**
 * The one write path for segments: creates, replaces or (with `next` null)
 * deletes the segment `key`, checks the result against the whole ruleset,
 * records the change for SDKs and writes the audit entry. `expectedVersion`
 * is the version the caller saw, 0 meaning the segment didn't exist. The
 * caller holds the environment lock.
 */
export async function writeSegment(
  trx: Db,
  scope: Scope,
  env: { id: string },
  key: string,
  next: SegmentContent | null,
  expectedVersion: number,
  action?: string,
): Promise<SegmentRow | null> {
  const before = await trx
    .selectFrom('segments')
    .selectAll()
    .where('environment_id', '=', env.id)
    .where('key', '=', key)
    .forUpdate()
    .executeTakeFirst();
  if (before === undefined) {
    if (expectedVersion !== 0 || next === null) throw notFound(`segment "${key}"`);
  } else if (expectedVersion === 0) {
    throw new AppError('already_exists', `segment "${key}" exists`);
  } else if (before.version !== expectedVersion) {
    throw versionConflict(`segment "${key}"`, before.version);
  }
  let after: SegmentRow | null = null;
  if (next === null) {
    await validateCandidate(trx, env.id, (rs) => {
      Reflect.deleteProperty(rs.segments, key);
    });
    await trx
      .deleteFrom('segments')
      .where('id', '=', (before as SegmentRow).id)
      .execute();
  } else {
    const values = {
      name: next.name,
      description: next.description,
      included: JSON.stringify(next.included),
      excluded: JSON.stringify(next.excluded),
      rules: JSON.stringify(next.rules),
    };
    after =
      before === undefined
        ? await trx
            .insertInto('segments')
            .values({ environment_id: env.id, key, ...values })
            .returningAll()
            .executeTakeFirstOrThrow()
        : await trx
            .updateTable('segments')
            .set({ ...values, version: before.version + 1, updated_at: new Date() })
            .where('id', '=', before.id)
            .returningAll()
            .executeTakeFirstOrThrow();
    const asRuleset = toSegment(after);
    await validateCandidate(trx, env.id, (rs) => {
      rs.segments[key] = asRuleset;
    });
  }
  await recordChange(trx, env.id, 'segment', key, scope.retention);
  await recordAudit(trx, {
    projectId: scope.project.id,
    environmentId: env.id,
    actor: scope.actor,
    action:
      action ??
      (before === undefined
        ? 'segment.create'
        : after === null
          ? 'segment.delete'
          : 'segment.update'),
    targetType: 'segment',
    targetKey: key,
    ...(before === undefined ? {} : { before: content(before) }),
    ...(after === null ? {} : { after: content(after) }),
  });
  return after;
}

/** A direct segment edit: refused in protected environments, which take them only through change requests. */
async function directWrite(
  scope: Scope,
  env: { id: string; key: string },
  key: string,
  next: SegmentContent | null,
  expectedVersion: number,
): Promise<SegmentRow | null> {
  return scope.db.transaction().execute(async (trx) => {
    await lockEnvironments(trx, [env.id]);
    await requireUnprotected(trx, env, 'segment changes');
    await requireNote(trx, env, scope.actor.note);
    return writeSegment(trx, scope, env, key, next, expectedVersion);
  });
}

function inputContent(input: Omit<SegmentInput, 'key'>): SegmentContent {
  return {
    name: input.name,
    description: input.description ?? '',
    included: input.included,
    excluded: input.excluded,
    rules: input.rules,
  };
}

/** Version 0 means "absent" to writeSegment; to an edit or delete it is just stale. */
async function refuseVersionZero(db: Db, env: { id: string }, key: string): Promise<never> {
  const live = await liveSegment(db, env.id, key);
  if (live.content === null) throw notFound(`segment "${key}"`);
  throw versionConflict(`segment "${key}"`, live.version);
}

export async function createSegment(
  scope: Scope,
  env: { id: string; key: string },
  input: SegmentInput,
): Promise<SegmentView> {
  const row = await directWrite(scope, env, input.key, inputContent(input), 0);
  return view(row as SegmentRow);
}

export async function updateSegment(
  scope: Scope,
  env: { id: string; key: string },
  key: string,
  input: Omit<SegmentInput, 'key'>,
  version: number,
): Promise<SegmentView> {
  if (version === 0) await refuseVersionZero(scope.db, env, key);
  const row = await directWrite(scope, env, key, inputContent(input), version);
  return view(row as SegmentRow);
}

export async function deleteSegment(
  scope: Scope,
  env: { id: string; key: string },
  key: string,
  version: number,
): Promise<void> {
  if (version === 0) await refuseVersionZero(scope.db, env, key);
  await directWrite(scope, env, key, null, version);
}
