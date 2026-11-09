import { diff, type DiffEntry, type Variant } from '@flagship/core';
import type { Db } from '../db/database.js';
import type { SnapshotKind } from '../db/schema.js';
import { AppError, notFound } from '../errors.js';
import { proposeChange, proposeSegmentChange, type ChangeRequestView } from './changeRequests.js';
import {
  configView,
  requireNote,
  updateFlag,
  versionConflict,
  writeConfig,
  type EnvConfig,
  type Scope,
} from './flags.js';
import { jsonEqual } from './merge.js';
import { lockEnvironments } from './rulesets.js';
import { liveSegment, writeSegment, type SegmentContent } from './segments.js';

/** Which side of a history entry to go back to. */
export type RestoreSide = 'before' | 'after';

/** A flag's settings as History restores them: everything but its key, type and archive state. */
export interface FlagSettings {
  name: string;
  description: string;
  variants: Variant[];
  clientSide: boolean;
}

type State = FlagSettings | EnvConfig | SegmentContent;

/** What restoring an entry would do, for review before it is done. */
export interface RestorePlan {
  entry: number;
  kind: SnapshotKind;
  target: string;
  environment: string | null;
  to: RestoreSide;
  /** The live version the restore is computed against; send it back to restore. */
  baseVersion: number;
  /** The live state, or null when the target does not exist. */
  current: State | null;
  /** The state the restore writes, or null to delete the target. */
  restored: State | null;
  /** From current to restored. */
  diff: DiffEntry[];
  /** Above zero, the restore opens a change request that needs this many approvals. */
  requiredApprovals: number;
  /** True when the live state already is the restored one. */
  unchanged: boolean;
}

export interface RestoreInput {
  to: RestoreSide;
  baseVersion: number;
  /** For a change request in a protected environment; a default names the entry. */
  title?: string | undefined;
  description?: string | undefined;
}

export type RestoreOutcome =
  | { outcome: 'applied'; plan: RestorePlan }
  | { outcome: 'proposed'; changeRequest: ChangeRequestView };

interface Source {
  id: number;
  kind: SnapshotKind;
  key: string;
  actor: string;
  at: Date;
  reason: string | null;
  state: State | null;
  env: { id: string; key: string; requiredApprovals: number } | null;
}

function settingsOf(v: unknown): FlagSettings | null {
  if (v === null || typeof v !== 'object') return null;
  const f = v as FlagSettings;
  return {
    name: f.name,
    description: f.description,
    variants: f.variants,
    clientSide: f.clientSide,
  };
}

async function loadSource(
  db: Db,
  projectId: string,
  id: number,
  side: RestoreSide,
): Promise<Source> {
  const row = await db
    .selectFrom('audit_log')
    .leftJoin('environments', 'environments.id', 'audit_log.environment_id')
    .select([
      'audit_log.id',
      'audit_log.snapshot',
      'audit_log.target_key',
      'audit_log.actor_name',
      'audit_log.created_at',
      'audit_log.reason',
      'audit_log.before',
      'audit_log.after',
      'environments.id as env_id',
      'environments.key as env_key',
      'environments.required_approvals',
    ])
    .where('audit_log.id', '=', id)
    .where('audit_log.project_id', '=', projectId)
    .executeTakeFirst();
  if (row === undefined) throw notFound(`history entry ${id}`);
  if (row.snapshot === null) {
    throw new AppError(
      'invalid_argument',
      `history entry ${id} did not change a flag or segment, so there is nothing to restore`,
    );
  }
  const raw: unknown = (side === 'after' ? row.after : row.before) ?? null;
  const env =
    row.env_id === null || row.env_key === null || row.required_approvals === null
      ? null
      : { id: row.env_id, key: row.env_key, requiredApprovals: row.required_approvals };
  if (row.snapshot !== 'flag' && env === null) {
    throw new AppError(
      'failed_precondition',
      `the environment of history entry ${id} no longer exists`,
    );
  }
  const state = row.snapshot === 'flag' ? settingsOf(raw) : (raw as State | null);
  if (state === null && row.snapshot !== 'segment') {
    throw new AppError(
      'invalid_argument',
      `flag "${row.target_key}" did not exist before history entry ${id}; archive it instead`,
    );
  }
  return {
    id: row.id,
    kind: row.snapshot,
    key: row.target_key,
    actor: row.actor_name,
    at: row.created_at,
    reason: row.reason,
    state,
    env: row.snapshot === 'flag' ? null : env,
  };
}

async function liveOf(
  db: Db,
  projectId: string,
  s: Source,
): Promise<{ version: number; state: State | null }> {
  if (s.kind === 'segment') {
    const live = await liveSegment(db, (s.env as { id: string }).id, s.key);
    return { version: live.version, state: live.content };
  }
  const flag = await db
    .selectFrom('flags')
    .selectAll()
    .where('project_id', '=', projectId)
    .where('key', '=', s.key)
    .executeTakeFirst();
  if (flag === undefined) throw notFound(`flag "${s.key}"`);
  if (s.kind === 'flag') {
    return {
      version: flag.version,
      state: settingsOf({ ...flag, clientSide: flag.client_side }),
    };
  }
  const config = await db
    .selectFrom('flag_configs')
    .selectAll()
    .where('flag_id', '=', flag.id)
    .where('environment_id', '=', (s.env as { id: string }).id)
    .executeTakeFirstOrThrow();
  return { version: config.version, state: configView(config) };
}

function planOf(s: Source, side: RestoreSide, live: { version: number; state: State | null }) {
  return {
    entry: s.id,
    kind: s.kind,
    target: s.key,
    environment: s.env?.key ?? null,
    to: side,
    baseVersion: live.version,
    current: live.state,
    restored: s.state,
    diff: diff(live.state ?? undefined, s.state ?? undefined),
    requiredApprovals: s.env?.requiredApprovals ?? 0,
    unchanged: jsonEqual(live.state, s.state),
  } satisfies RestorePlan;
}

/** Shows what restoring the state before or after a history entry would change. */
export async function planRestore(
  db: Db,
  projectId: string,
  id: number,
  side: RestoreSide,
): Promise<RestorePlan> {
  const s = await loadSource(db, projectId, id, side);
  return planOf(s, side, await liveOf(db, projectId, s));
}

function unchanged(s: Source): AppError {
  return new AppError(
    'invalid_argument',
    `${describe(s)} already matches history entry ${s.id}; there is nothing to restore`,
  );
}

function describe(s: Source): string {
  if (s.kind === 'flag') return `the settings of flag "${s.key}"`;
  const env = (s.env as { key: string }).key;
  return s.kind === 'targeting'
    ? `the targeting of flag "${s.key}" in ${env}`
    : `segment "${s.key}" in ${env}`;
}

function defaultTitle(s: Source, side: RestoreSide): string {
  const what = s.kind === 'targeting' ? `targeting of ${s.key}` : `segment ${s.key}`;
  return `Restore ${what} to ${side} change #${s.id}`.slice(0, 200);
}

function defaultDescription(s: Source, side: RestoreSide): string {
  const why = s.reason === null ? '' : ` ("${s.reason}")`;
  return `Puts back the state ${side} change #${s.id}, made by ${s.actor} at ${s.at.toISOString()}${why}.`;
}

/**
 * Puts a target back to its state before or after a history entry. The
 * caller reviewed a plan computed against `baseVersion`, which must still be
 * live. In an environment that takes changes only through approved change
 * requests, the restore opens one instead of writing; the decision is made
 * under the environment lock, so it can't race protection being turned on.
 * Restored state is validated like any edit: targeting that refers to a
 * deleted segment, prerequisite or variant is refused with the reason.
 */
export async function restoreEntry(
  scope: Scope,
  id: number,
  input: RestoreInput,
): Promise<RestoreOutcome> {
  const s = await loadSource(scope.db, scope.project.id, id, input.to);
  if (s.kind === 'flag') {
    const live = await liveOf(scope.db, scope.project.id, s);
    if (live.version !== input.baseVersion) {
      throw versionConflict(`flag "${s.key}"`, live.version);
    }
    if (jsonEqual(live.state, s.state)) throw unchanged(s);
    await updateFlag(
      scope,
      s.key,
      { version: input.baseVersion, ...(s.state as FlagSettings) },
      'flag.settings.restore',
    );
    return {
      outcome: 'applied',
      plan: await planRestore(scope.db, scope.project.id, id, input.to),
    };
  }
  const env = s.env as { id: string; key: string };
  const applied = await scope.db.transaction().execute(async (trx) => {
    await lockEnvironments(trx, [env.id]);
    const { required_approvals } = await trx
      .selectFrom('environments')
      .select('required_approvals')
      .where('id', '=', env.id)
      .executeTakeFirstOrThrow();
    if (required_approvals > 0) return false;
    await requireNote(trx, env, scope.actor.note);
    if (s.kind === 'targeting') {
      await writeConfig(
        trx,
        scope,
        env,
        s.key,
        (current) => {
          if (jsonEqual(current, s.state)) throw unchanged(s);
          return s.state as EnvConfig;
        },
        input.baseVersion,
        'flag.config.restore',
      );
    } else {
      const live = await liveSegment(trx, env.id, s.key);
      if (live.version !== input.baseVersion) {
        throw versionConflict(`segment "${s.key}"`, live.version);
      }
      if (jsonEqual(live.content, s.state)) throw unchanged(s);
      await writeSegment(
        trx,
        scope,
        env,
        s.key,
        s.state as SegmentContent | null,
        input.baseVersion,
        'segment.restore',
      );
    }
    return true;
  });
  if (applied) {
    return {
      outcome: 'applied',
      plan: await planRestore(scope.db, scope.project.id, id, input.to),
    };
  }
  const proposal = {
    baseVersion: input.baseVersion,
    title: input.title ?? defaultTitle(s, input.to),
    description: input.description ?? defaultDescription(s, input.to),
  };
  const changeRequest =
    s.kind === 'targeting'
      ? await proposeChange(scope, env, s.key, { ...proposal, config: s.state as EnvConfig })
      : await proposeSegmentChange(scope, env, s.key, {
          ...proposal,
          segment: s.state as SegmentContent | null,
        });
  return { outcome: 'proposed', changeRequest };
}
