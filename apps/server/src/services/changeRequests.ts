import { diff, type DiffEntry } from '@flagship/core';
import { sql } from 'kysely';
import type { Db } from '../db/database.js';
import type { ChangeRequestStatus, ReviewDecision } from '../db/schema.js';
import { AppError, notFound } from '../errors.js';
import { recordAudit } from './audit.js';
import {
  configView,
  validateCandidate,
  versionConflict,
  writeConfig,
  type EnvConfig,
  type Scope,
} from './flags.js';
import { jsonEqual, mergeSet, threeWayMerge, type MergeConflict } from './merge.js';
import { lockEnvironments, toFlag, toSegment } from './rulesets.js';
import { liveSegment, writeSegment, type SegmentContent } from './segments.js';

/** Arrays of a flag's targeting that merge element by element, and their key. */
export const TARGETING_KEYS = { rules: 'id', prerequisites: 'flag' } as const;

/** Arrays of a segment that merge element by element (members merge as sets). */
export const SEGMENT_KEYS = { rules: 'id' } as const;

/** Open change requests one flag or segment can have in one environment. */
export const MAX_OPEN_PER_TARGET = 20;

/** What a request changes: a flag's targeting in one environment, or a segment there. */
export type TargetKind = 'flag' | 'segment';

/**
 * One side of a request: flag targeting, or segment content where null means
 * the segment doesn't exist (a request to create one has a null base, one to
 * delete has a null proposal).
 */
export type Proposal = EnvConfig | SegmentContent | null;

export interface ReviewView {
  id: number;
  revision: number;
  reviewer: string;
  decision: ReviewDecision;
  body: string;
  at: string;
}

export interface LiveState {
  /** The target's version live now; 0 for a segment that doesn't exist. */
  version: number;
  /** Whether the live target moved on since the proposal's base. */
  stale: boolean;
  /** What changed live since the base; empty unless stale. */
  changedSinceBase: DiffEntry[];
  /** Parts both the proposal and the live target changed, differently. */
  conflicts: MergeConflict[];
}

export interface ChangeRequestView {
  id: string;
  target: TargetKind;
  /** The flag, for a targeting request. */
  flag: string | null;
  /** The segment, for a segment request. */
  segment: string | null;
  environment: string;
  title: string;
  description: string;
  status: ChangeRequestStatus;
  /** Goes up when the proposal changes; reviews count for the revision they saw. */
  revision: number;
  author: string;
  /** The author's user id, so a client can tell its own requests apart; null once deleted. */
  authorId: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  finishedBy: string | null;
  baseVersion: number;
  base: Proposal;
  proposed: Proposal;
  diff: DiffEntry[];
  approvals: { required: number; approvedBy: string[]; changesRequestedBy: string[] };
  /** Only for open requests. */
  live: LiveState | null;
  /** Approved, nothing requested and not stale: apply would go through now. */
  canApply: boolean;
  reviews: ReviewView[];
}

export interface ProposalInput {
  baseVersion: number;
  title: string;
  description?: string | undefined;
  config: EnvConfig;
}

export interface SegmentProposalInput {
  /** The live segment's version, or 0 to propose creating it. */
  baseVersion: number;
  title: string;
  description?: string | undefined;
  /** The segment's new content, or null to propose deleting it. */
  segment: SegmentContent | null;
}

interface RequestRow {
  id: string;
  project_id: string;
  environment_id: string;
  flag_id: string | null;
  segment_key: string | null;
  title: string;
  description: string;
  base_version: number;
  base: unknown;
  proposed: unknown;
  revision: number;
  status: ChangeRequestStatus;
  author_id: string | null;
  author_name: string;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
  finished_by_name: string | null;
  flag_key: string | null;
  environment_key: string;
  required_approvals: number;
}

interface ReviewRow {
  id: number;
  revision: number;
  reviewer_id: string | null;
  reviewer_name: string;
  decision: ReviewDecision;
  body: string;
  created_at: Date;
}

function kindOf(r: { segment_key: string | null }): TargetKind {
  return r.segment_key === null ? 'flag' : 'segment';
}

function keyOf(r: { segment_key: string | null; flag_key: string | null }): string {
  return r.segment_key ?? (r.flag_key as string);
}

/** Audit action of a request step: `flag.change_request.apply`, `segment.change_request.open`. */
function action(kind: TargetKind, step: string): string {
  return `${kind}.change_request.${step}`;
}

function describeTarget(kind: TargetKind, key: string, environment: string): string {
  return kind === 'flag'
    ? `the targeting of flag "${key}" in ${environment}`
    : `segment "${key}" in ${environment}`;
}

function failedPrecondition(message: string, details?: unknown): AppError {
  return new AppError('failed_precondition', message, details);
}

/** Approvals a request needs: the environment's setting, and at least one. */
export function approvalsNeeded(requiredApprovals: number): number {
  return Math.max(1, requiredApprovals);
}

/**
 * Each reviewer's standing decision on the current revision: their latest
 * approve or request-changes there. Comments don't change it, and a review of
 * an earlier revision doesn't count, so a rebase asks everyone again.
 */
export function tally(
  reviews: readonly ReviewRow[],
  revision: number,
): { approvedBy: string[]; changesRequestedBy: string[] } {
  const latest = new Map<string, ReviewRow>();
  for (const r of reviews) {
    if (r.revision !== revision || r.decision === 'comment') continue;
    const who = r.reviewer_id ?? `name:${r.reviewer_name}`;
    const seen = latest.get(who);
    if (seen === undefined || seen.id < r.id) latest.set(who, r);
  }
  const standing = [...latest.values()].sort((a, b) => a.id - b.id);
  return {
    approvedBy: standing.filter((r) => r.decision === 'approve').map((r) => r.reviewer_name),
    changesRequestedBy: standing
      .filter((r) => r.decision === 'request_changes')
      .map((r) => r.reviewer_name),
  };
}

function selectRequests(db: Db) {
  return db
    .selectFrom('change_requests')
    .leftJoin('flags', 'flags.id', 'change_requests.flag_id')
    .innerJoin('environments', 'environments.id', 'change_requests.environment_id')
    .selectAll('change_requests')
    .select([
      'flags.key as flag_key',
      'environments.key as environment_key',
      'environments.required_approvals',
    ]);
}

async function loadRequest(
  db: Db,
  projectId: string,
  id: string,
  lock: boolean,
): Promise<RequestRow> {
  const query = selectRequests(db)
    .where('change_requests.id', '=', id)
    .where('change_requests.project_id', '=', projectId);
  const row = await (lock ? query.forUpdate('change_requests') : query).executeTakeFirst();
  if (row === undefined) throw notFound(`change request ${id}`);
  return row;
}

async function reviewsOf(db: Db, ids: readonly string[]): Promise<Map<string, ReviewRow[]>> {
  const out = new Map<string, ReviewRow[]>(ids.map((id) => [id, []]));
  if (ids.length === 0) return out;
  const rows = await db
    .selectFrom('change_request_reviews')
    .select([
      'id',
      'change_request_id',
      'revision',
      'reviewer_id',
      'reviewer_name',
      'decision',
      'body',
      'created_at',
    ])
    .where('change_request_id', 'in', [...ids])
    .orderBy('id')
    .execute();
  for (const r of rows) out.get(r.change_request_id)?.push(r);
  return out;
}

interface Live {
  version: number;
  value: Proposal;
}

async function liveConfig(db: Db, flagId: string, environmentId: string): Promise<Live> {
  const row = await db
    .selectFrom('flag_configs')
    .selectAll()
    .where('flag_id', '=', flagId)
    .where('environment_id', '=', environmentId)
    .executeTakeFirstOrThrow();
  return { version: row.version, value: configView(row) };
}

async function liveSegmentState(db: Db, environmentId: string, key: string): Promise<Live> {
  const live = await liveSegment(db, environmentId, key);
  return { version: live.version, value: live.content };
}

function readLive(db: Db, r: RequestRow): Promise<Live> {
  return r.segment_key === null
    ? liveConfig(db, r.flag_id as string, r.environment_id)
    : liveSegmentState(db, r.environment_id, r.segment_key);
}

/** Root-level diff of two sides, where null (no segment) is an added or removed root. */
function diffOf(before: Proposal, after: Proposal): DiffEntry[] {
  return diff(before ?? undefined, after ?? undefined);
}

/**
 * Three-way merge of segment content. Included and excluded members merge
 * as sets: each side's additions and removals both apply, so two people
 * adding different users never conflict. Rules merge by `id`. When the
 * segment is missing on any side (created or deleted), the whole segment is
 * one value, so deleting it while the other side edits it is a conflict.
 */
export function mergeSegment(
  base: SegmentContent | null,
  ours: SegmentContent | null,
  theirs: SegmentContent | null,
): { merged: SegmentContent | null; conflicts: MergeConflict[] } {
  if (base === null || ours === null || theirs === null) {
    const { merged, conflicts } = threeWayMerge(base, ours, theirs);
    return {
      merged,
      conflicts: conflicts.map((c) => (c.path === '' ? { ...c, path: 'segment' } : c)),
    };
  }
  const rest = (c: SegmentContent) => ({
    name: c.name,
    description: c.description,
    rules: c.rules,
  });
  const { merged, conflicts } = threeWayMerge(rest(base), rest(ours), rest(theirs), SEGMENT_KEYS);
  return {
    merged: {
      ...merged,
      included: mergeSet(base.included, ours.included, theirs.included),
      excluded: mergeSet(base.excluded, ours.excluded, theirs.excluded),
    },
    conflicts,
  };
}

/**
 * Whether the live target moved on since the base. Flag targeting versions
 * only go up, so the version says it all. A segment deleted and created again
 * starts over at version 1, so its content is compared too.
 */
function isStale(kind: TargetKind, base: Proposal, baseVersion: number, live: Live): boolean {
  if (live.version !== baseVersion) return true;
  return kind === 'segment' && !jsonEqual(base, live.value);
}

/** Compares an open request with the live target: is it stale, and does it still merge? */
export function liveState(
  kind: TargetKind,
  base: Proposal,
  proposed: Proposal,
  baseVersion: number,
  live: Live,
): LiveState & { merged: Proposal } {
  if (!isStale(kind, base, baseVersion, live)) {
    return {
      version: live.version,
      stale: false,
      changedSinceBase: [],
      conflicts: [],
      merged: proposed,
    };
  }
  const { merged, conflicts } =
    kind === 'flag'
      ? threeWayMerge(base, proposed, live.value, TARGETING_KEYS)
      : mergeSegment(
          base as SegmentContent | null,
          proposed as SegmentContent | null,
          live.value as SegmentContent | null,
        );
  return {
    version: live.version,
    stale: true,
    changedSinceBase: diffOf(base, live.value),
    conflicts,
    merged,
  };
}

function toView(r: RequestRow, reviews: ReviewRow[], live: LiveState | null): ChangeRequestView {
  const base = r.base as Proposal;
  const proposed = r.proposed as Proposal;
  const required = approvalsNeeded(r.required_approvals);
  const { approvedBy, changesRequestedBy } = tally(reviews, r.revision);
  return {
    id: r.id,
    target: kindOf(r),
    flag: r.segment_key === null ? r.flag_key : null,
    segment: r.segment_key,
    environment: r.environment_key,
    title: r.title,
    description: r.description,
    status: r.status,
    revision: r.revision,
    author: r.author_name,
    authorId: r.author_id,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    finishedAt: r.finished_at?.toISOString() ?? null,
    finishedBy: r.finished_by_name,
    baseVersion: r.base_version,
    base,
    proposed,
    diff: diffOf(base, proposed),
    approvals: { required, approvedBy, changesRequestedBy },
    live,
    canApply:
      r.status === 'open' &&
      live !== null &&
      !live.stale &&
      approvedBy.length >= required &&
      changesRequestedBy.length === 0,
    reviews: reviews.map((v) => ({
      id: v.id,
      revision: v.revision,
      reviewer: v.reviewer_name,
      decision: v.decision,
      body: v.body,
      at: v.created_at.toISOString(),
    })),
  };
}

async function viewOf(db: Db, r: RequestRow): Promise<ChangeRequestView> {
  const reviews = (await reviewsOf(db, [r.id])).get(r.id) ?? [];
  let live: LiveState | null = null;
  if (r.status === 'open') {
    const state = liveState(
      kindOf(r),
      r.base as Proposal,
      r.proposed as Proposal,
      r.base_version,
      await readLive(db, r),
    );
    live = {
      version: state.version,
      stale: state.stale,
      changedSinceBase: state.changedSinceBase,
      conflicts: state.conflicts,
    };
  }
  return toView(r, reviews, live);
}

export async function getChangeRequest(
  db: Db,
  projectId: string,
  id: string,
): Promise<ChangeRequestView> {
  return viewOf(db, await loadRequest(db, projectId, id, false));
}

export interface ChangeRequestSummary {
  id: string;
  target: TargetKind;
  flag: string | null;
  segment: string | null;
  environment: string;
  title: string;
  status: ChangeRequestStatus;
  revision: number;
  author: string;
  createdAt: string;
  updatedAt: string;
  approvals: { required: number; approvedBy: string[]; changesRequestedBy: string[] };
  /** Only for open requests: whether the live target moved on since the base. */
  stale: boolean | null;
}

/** Newest first, keyset-paginated on (created_at, id). */
export async function listChangeRequests(
  db: Db,
  projectId: string,
  filter: {
    status?: ChangeRequestStatus | undefined;
    environmentId?: string | undefined;
    flag?: string | undefined;
    segment?: string | undefined;
    before?: string | undefined;
    limit: number;
  },
): Promise<ChangeRequestSummary[]> {
  let q = selectRequests(db)
    .leftJoin('flag_configs', (j) =>
      j
        .onRef('flag_configs.flag_id', '=', 'change_requests.flag_id')
        .onRef('flag_configs.environment_id', '=', 'change_requests.environment_id'),
    )
    .leftJoin('segments', (j) =>
      j
        .onRef('segments.key', '=', 'change_requests.segment_key')
        .onRef('segments.environment_id', '=', 'change_requests.environment_id'),
    )
    .select([
      'flag_configs.version as flag_version',
      'segments.version as segment_version',
      'segments.name as segment_name',
      'segments.description as segment_description',
      'segments.included as segment_included',
      'segments.excluded as segment_excluded',
      'segments.rules as segment_rules',
    ])
    .where('change_requests.project_id', '=', projectId);
  if (filter.status !== undefined) q = q.where('change_requests.status', '=', filter.status);
  if (filter.environmentId !== undefined) {
    q = q.where('change_requests.environment_id', '=', filter.environmentId);
  }
  if (filter.flag !== undefined) q = q.where('flags.key', '=', filter.flag);
  if (filter.segment !== undefined) {
    q = q.where('change_requests.segment_key', '=', filter.segment);
  }
  if (filter.before !== undefined) {
    const cursor = filter.before;
    q = q.where(
      sql<boolean>`(change_requests.created_at, change_requests.id) < (
        SELECT c.created_at, c.id FROM change_requests c WHERE c.id = ${cursor})`,
    );
  }
  const rows = await q
    .orderBy('change_requests.created_at', 'desc')
    .orderBy('change_requests.id', 'desc')
    .limit(filter.limit)
    .execute();
  const reviews = await reviewsOf(
    db,
    rows.map((r) => r.id),
  );
  const live = (r: (typeof rows)[number]): Live =>
    r.segment_key === null
      ? { version: r.flag_version ?? 0, value: null }
      : r.segment_version === null
        ? { version: 0, value: null }
        : {
            version: r.segment_version,
            value: {
              name: r.segment_name as string,
              description: r.segment_description as string,
              included: r.segment_included as string[],
              excluded: r.segment_excluded as string[],
              rules: r.segment_rules as SegmentContent['rules'],
            },
          };
  return rows.map((r) => ({
    id: r.id,
    target: kindOf(r),
    flag: r.segment_key === null ? r.flag_key : null,
    segment: r.segment_key,
    environment: r.environment_key,
    title: r.title,
    status: r.status,
    revision: r.revision,
    author: r.author_name,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    approvals: {
      required: approvalsNeeded(r.required_approvals),
      ...tally(reviews.get(r.id) ?? [], r.revision),
    },
    stale:
      r.status === 'open' ? isStale(kindOf(r), r.base as Proposal, r.base_version, live(r)) : null,
  }));
}

async function validateProposal(
  trx: Db,
  projectId: string,
  environmentId: string,
  flagId: string,
  proposed: EnvConfig,
  version: number,
): Promise<void> {
  const flag = await trx
    .selectFrom('flags')
    .selectAll()
    .where('id', '=', flagId)
    .where('project_id', '=', projectId)
    .executeTakeFirstOrThrow();
  if (flag.archived_at !== null) {
    throw new AppError('invalid_argument', `flag "${flag.key}" is archived; restore it first`);
  }
  await validateCandidate(trx, environmentId, (rs) => {
    rs.flags[flag.key] = toFlag(flag, {
      enabled: proposed.enabled,
      off_variant: proposed.offVariant,
      prerequisites: proposed.prerequisites,
      rules: proposed.rules,
      fallthrough: proposed.fallthrough,
      version,
    });
  });
}

/**
 * Proposes new targeting for a flag in one environment. The proposal records
 * the targeting it was based on, which must be the live one, so reviewers see
 * exactly what would change. It is validated against today's ruleset now and
 * again when it is applied.
 */
export async function proposeChange(
  scope: Scope,
  env: { id: string; key: string },
  key: string,
  input: ProposalInput,
): Promise<ChangeRequestView> {
  const id = await scope.db.transaction().execute(async (trx) => {
    // Shares the flag row with targeting edits, so the base is a stable read.
    const flag = await trx
      .selectFrom('flags')
      .select('id')
      .where('project_id', '=', scope.project.id)
      .where('key', '=', key)
      .forShare()
      .executeTakeFirst();
    if (flag === undefined) throw notFound(`flag "${key}"`);
    const live = await liveConfig(trx, flag.id, env.id);
    if (live.version !== input.baseVersion) {
      throw versionConflict(`targeting of flag "${key}" in ${env.key}`, live.version);
    }
    if (jsonEqual(live.value, input.config)) {
      throw new AppError('invalid_argument', 'the proposal is the same as the live targeting');
    }
    const open = await trx
      .selectFrom('change_requests')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('flag_id', '=', flag.id)
      .where('environment_id', '=', env.id)
      .where('status', '=', 'open')
      .executeTakeFirstOrThrow();
    if (open.n >= MAX_OPEN_PER_TARGET) {
      throw new AppError(
        'resource_exhausted',
        `flag "${key}" already has ${MAX_OPEN_PER_TARGET} open change requests in ${env.key}`,
      );
    }
    await validateProposal(trx, scope.project.id, env.id, flag.id, input.config, live.version + 1);
    const row = await trx
      .insertInto('change_requests')
      .values({
        project_id: scope.project.id,
        environment_id: env.id,
        flag_id: flag.id,
        title: input.title,
        description: input.description ?? '',
        base_version: live.version,
        base: JSON.stringify(live.value),
        proposed: JSON.stringify(input.config),
        author_id: scope.actor.id,
        author_name: scope.actor.name,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await recordAudit(trx, {
      projectId: scope.project.id,
      environmentId: env.id,
      actor: scope.actor,
      action: action('flag', 'open'),
      targetType: 'flag',
      targetKey: key,
      before: live.value,
      after: input.config,
    });
    return row.id;
  });
  return getChangeRequest(scope.db, scope.project.id, id);
}

async function validateSegmentProposal(
  trx: Db,
  environmentId: string,
  key: string,
  proposed: SegmentContent | null,
  version: number,
): Promise<void> {
  await validateCandidate(trx, environmentId, (rs) => {
    if (proposed === null) Reflect.deleteProperty(rs.segments, key);
    else rs.segments[key] = toSegment({ key, ...proposed, version });
  });
}

/**
 * Proposes creating, changing or deleting a segment in one environment.
 * `baseVersion` is the live segment's version, or 0 when proposing a new
 * one, and `segment` is null to propose deleting it. Like a targeting
 * proposal it is checked against today's ruleset, so a delete that a flag
 * still depends on is refused here rather than at apply time.
 */
export async function proposeSegmentChange(
  scope: Scope,
  env: { id: string; key: string },
  key: string,
  input: SegmentProposalInput,
): Promise<ChangeRequestView> {
  const id = await scope.db.transaction().execute(async (trx) => {
    // Segment writers hold the environment lock, so the base is a stable read.
    await lockEnvironments(trx, [env.id]);
    const live = await liveSegment(trx, env.id, key);
    if (live.version !== input.baseVersion) {
      if (live.content === null) throw notFound(`segment "${key}" in ${env.key}`);
      throw versionConflict(`segment "${key}" in ${env.key}`, live.version);
    }
    if (live.content === null && input.segment === null) {
      throw new AppError('invalid_argument', `segment "${key}" doesn't exist in ${env.key}`);
    }
    if (jsonEqual(live.content, input.segment)) {
      throw new AppError('invalid_argument', 'the proposal is the same as the live segment');
    }
    const open = await trx
      .selectFrom('change_requests')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('environment_id', '=', env.id)
      .where('segment_key', '=', key)
      .where('status', '=', 'open')
      .executeTakeFirstOrThrow();
    if (open.n >= MAX_OPEN_PER_TARGET) {
      throw new AppError(
        'resource_exhausted',
        `segment "${key}" already has ${MAX_OPEN_PER_TARGET} open change requests in ${env.key}`,
      );
    }
    await validateSegmentProposal(trx, env.id, key, input.segment, live.version + 1);
    const row = await trx
      .insertInto('change_requests')
      .values({
        project_id: scope.project.id,
        environment_id: env.id,
        flag_id: null,
        segment_key: key,
        title: input.title,
        description: input.description ?? '',
        base_version: live.version,
        base: JSON.stringify(live.content),
        proposed: JSON.stringify(input.segment),
        author_id: scope.actor.id,
        author_name: scope.actor.name,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await recordAudit(trx, {
      projectId: scope.project.id,
      environmentId: env.id,
      actor: scope.actor,
      action: action('segment', 'open'),
      targetType: 'segment',
      targetKey: key,
      ...(live.content === null ? {} : { before: live.content }),
      ...(input.segment === null ? {} : { after: input.segment }),
    });
    return row.id;
  });
  return getChangeRequest(scope.db, scope.project.id, id);
}

function requireOpen(r: RequestRow): void {
  if (r.status !== 'open') {
    throw failedPrecondition(`change request is ${r.status}`, { status: r.status });
  }
}

function requireRevision(r: RequestRow, revision: number): void {
  if (r.revision !== revision) {
    throw new AppError(
      'version_conflict',
      'the change request was updated since you loaded it; reload and review it again',
      { currentRevision: r.revision },
    );
  }
}

/**
 * Adds a comment, an approval or a request for changes. Decisions apply to
 * the revision the reviewer saw, which must be the current one. Authors can
 * comment on their own request but not decide on it.
 */
export async function reviewChange(
  scope: Scope,
  id: string,
  input: { decision: ReviewDecision; body?: string | undefined; revision: number },
): Promise<ChangeRequestView> {
  const body = input.body ?? '';
  if (input.decision === 'comment' && body.trim() === '') {
    throw new AppError('invalid_argument', 'a comment needs some text', [
      { path: 'body', message: 'must not be empty' },
    ]);
  }
  await scope.db.transaction().execute(async (trx) => {
    const r = await loadRequest(trx, scope.project.id, id, true);
    requireOpen(r);
    requireRevision(r, input.revision);
    if (input.decision !== 'comment' && scope.actor.id !== null && r.author_id === scope.actor.id) {
      throw new AppError(
        'permission_denied',
        input.decision === 'approve'
          ? 'authors cannot approve their own change request'
          : 'authors cannot request changes on their own change request',
      );
    }
    await trx
      .insertInto('change_request_reviews')
      .values({
        change_request_id: r.id,
        revision: r.revision,
        reviewer_id: scope.actor.id,
        reviewer_name: scope.actor.name,
        decision: input.decision,
        body,
      })
      .execute();
    await trx
      .updateTable('change_requests')
      .set({ updated_at: new Date() })
      .where('id', '=', r.id)
      .execute();
    if (input.decision !== 'comment') {
      await recordAudit(trx, {
        projectId: scope.project.id,
        environmentId: r.environment_id,
        actor: scope.actor,
        action: action(kindOf(r), input.decision),
        targetType: kindOf(r),
        targetKey: keyOf(r),
        after: { changeRequest: r.id, revision: r.revision, body },
      });
    }
  });
  return getChangeRequest(scope.db, scope.project.id, id);
}

/**
 * Applies an approved request. The live targeting must still be the base it
 * was proposed against: the write goes through the normal path with the base
 * version as its precondition, so a request that has gone stale is refused
 * (rebase it first) and two requests based on the same version can't both
 * land. The request row is locked first, so two applies of one request give
 * one winner and the other sees it applied.
 */
export async function applyChange(
  scope: Scope,
  id: string,
  input: { revision: number },
): Promise<ChangeRequestView> {
  await scope.db.transaction().execute(async (trx) => {
    const r = await loadRequest(trx, scope.project.id, id, true);
    requireOpen(r);
    requireRevision(r, input.revision);
    const reviews = (await reviewsOf(trx, [r.id])).get(r.id) ?? [];
    const { approvedBy, changesRequestedBy } = tally(reviews, r.revision);
    if (changesRequestedBy.length > 0) {
      throw failedPrecondition(`changes were requested by ${changesRequestedBy.join(', ')}`, {
        changesRequestedBy,
      });
    }
    const required = approvalsNeeded(r.required_approvals);
    if (approvedBy.length < required) {
      throw failedPrecondition(
        `this change request needs ${required} approval${required === 1 ? '' : 's'}, it has ${approvedBy.length}`,
        { required, approvedBy },
      );
    }
    const kind = kindOf(r);
    const env = { id: r.environment_id, key: r.environment_key };
    const stale = async (): Promise<AppError> => {
      const state = liveState(
        kind,
        r.base as Proposal,
        r.proposed as Proposal,
        r.base_version,
        await readLive(trx, r),
      );
      return new AppError(
        'version_conflict',
        `${describeTarget(kind, keyOf(r), r.environment_key)} changed since this request was proposed; rebase it and have it reviewed again`,
        { currentVersion: state.version, conflicts: state.conflicts },
      );
    };
    if (r.segment_key !== null) {
      // The version alone can't tell a recreated segment from the base, so
      // the content is compared too, under the lock every segment writer takes.
      await lockEnvironments(trx, [r.environment_id]);
      const live = await readLive(trx, r);
      if (isStale(kind, r.base as Proposal, r.base_version, live)) throw await stale();
      await writeSegment(
        trx,
        scope,
        env,
        r.segment_key,
        r.proposed as SegmentContent | null,
        r.base_version,
        action(kind, 'apply'),
      );
    } else {
      const proposed = r.proposed as EnvConfig;
      try {
        await writeConfig(
          trx,
          scope,
          env,
          r.flag_key as string,
          () => proposed,
          r.base_version,
          action(kind, 'apply'),
        );
      } catch (err) {
        if (err instanceof AppError && err.code === 'version_conflict') throw await stale();
        throw err;
      }
    }
    await trx
      .updateTable('change_requests')
      .set({
        status: 'applied',
        finished_at: new Date(),
        finished_by_name: scope.actor.name,
        updated_at: new Date(),
      })
      .where('id', '=', r.id)
      .execute();
  });
  return getChangeRequest(scope.db, scope.project.id, id);
}

/**
 * Moves a stale request onto the live targeting with a three-way merge: the
 * proposal's changes are replayed on top of what changed live. Parts both
 * sides changed differently are conflicts, returned with all three values,
 * and nothing is written. A successful rebase is a new revision, so earlier
 * approvals no longer count.
 */
export async function rebaseChange(
  scope: Scope,
  id: string,
  input: { revision: number },
): Promise<ChangeRequestView> {
  await scope.db.transaction().execute(async (trx) => {
    const r = await loadRequest(trx, scope.project.id, id, true);
    requireOpen(r);
    requireRevision(r, input.revision);
    // Serialises with targeting and segment writers, so the live read stays live.
    await lockEnvironments(trx, [r.environment_id]);
    const kind = kindOf(r);
    const live = await readLive(trx, r);
    const state = liveState(kind, r.base as Proposal, r.proposed as Proposal, r.base_version, live);
    if (!state.stale) {
      throw new AppError('invalid_argument', 'the change request is already up to date');
    }
    if (state.conflicts.length > 0) {
      throw failedPrecondition(
        `the proposal and the live ${kind === 'flag' ? 'targeting' : 'segment'} both changed ${state.conflicts.length === 1 ? 'one part' : `${state.conflicts.length} parts`} differently`,
        { conflicts: state.conflicts },
      );
    }
    if (jsonEqual(state.merged, live.value)) {
      throw failedPrecondition('everything this request proposes is already live; close it');
    }
    if (r.segment_key === null) {
      await validateProposal(
        trx,
        scope.project.id,
        r.environment_id,
        r.flag_id as string,
        state.merged as EnvConfig,
        live.version + 1,
      );
    } else {
      await validateSegmentProposal(
        trx,
        r.environment_id,
        r.segment_key,
        state.merged as SegmentContent | null,
        live.version + 1,
      );
    }
    await trx
      .updateTable('change_requests')
      .set({
        base_version: live.version,
        base: JSON.stringify(live.value),
        proposed: JSON.stringify(state.merged),
        revision: r.revision + 1,
        updated_at: new Date(),
      })
      .where('id', '=', r.id)
      .execute();
    await recordAudit(trx, {
      projectId: scope.project.id,
      environmentId: r.environment_id,
      actor: scope.actor,
      action: action(kind, 'rebase'),
      targetType: kind,
      targetKey: keyOf(r),
      before: r.proposed,
      after: state.merged,
    });
  });
  return getChangeRequest(scope.db, scope.project.id, id);
}

/** Closes a request without applying it. Its author or an admin can do this. */
export async function closeChange(
  scope: Scope,
  id: string,
  isAdmin: boolean,
  input: { reason?: string | undefined },
): Promise<ChangeRequestView> {
  await scope.db.transaction().execute(async (trx) => {
    const r = await loadRequest(trx, scope.project.id, id, true);
    requireOpen(r);
    if (!isAdmin && (scope.actor.id === null || r.author_id !== scope.actor.id)) {
      throw new AppError(
        'permission_denied',
        'only the author or an admin can close a change request',
      );
    }
    const reason = input.reason ?? '';
    if (reason !== '') {
      await trx
        .insertInto('change_request_reviews')
        .values({
          change_request_id: r.id,
          revision: r.revision,
          reviewer_id: scope.actor.id,
          reviewer_name: scope.actor.name,
          decision: 'comment',
          body: reason,
        })
        .execute();
    }
    await trx
      .updateTable('change_requests')
      .set({
        status: 'closed',
        finished_at: new Date(),
        finished_by_name: scope.actor.name,
        updated_at: new Date(),
      })
      .where('id', '=', r.id)
      .execute();
    await recordAudit(trx, {
      projectId: scope.project.id,
      environmentId: r.environment_id,
      actor: scope.actor,
      action: action(kindOf(r), 'close'),
      targetType: kindOf(r),
      targetKey: keyOf(r),
      after: { changeRequest: r.id, reason },
    });
  });
  return getChangeRequest(scope.db, scope.project.id, id);
}
