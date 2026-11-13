import type { Flag, LifecycleStage, Segment } from '@flagship/core';
import type { ColumnType, Generated } from 'kysely';

type CreatedAt = ColumnType<Date, never, never>;
type UpdatedAt = ColumnType<Date, never, Date>;
type Json<T> = ColumnType<T, string, string>;

export type Role = 'viewer' | 'editor' | 'admin';
export type KeyKind = 'server' | 'client';
export type ScheduleStatus = 'pending' | 'applied' | 'failed' | 'cancelled';
export type RolloutStatus = 'active' | 'paused' | 'completed' | 'cancelled' | 'failed';
/** Who paused a plan: a person, the kill switch, or an edit to the targeted serve. */
export type PausedReason = 'manual' | 'kill_switch' | 'edited';

export interface UsersTable {
  id: Generated<string>;
  email: string;
  name: string;
  password_hash: string;
  role: Role;
  disabled_at: Date | null;
  created_at: CreatedAt;
}

export interface SessionsTable {
  token_hash: Buffer;
  user_id: string;
  csrf_token: string;
  // Written from the app clock so expiry is computed against one time source.
  created_at: ColumnType<Date, Date, never>;
  last_seen_at: Date;
  expires_at: Date;
}

export interface ProjectsTable {
  id: Generated<string>;
  key: string;
  name: string;
  created_at: CreatedAt;
}

export interface EnvironmentsTable {
  id: Generated<string>;
  project_id: string;
  key: string;
  name: string;
  ruleset_version: Generated<number>;
  /** Approvals a change request needs here; above zero, direct targeting edits are refused. */
  required_approvals: Generated<number>;
  /** Every change here must give a reason. */
  require_reason: Generated<boolean>;
  /** Every change here must give a ticket link. */
  require_link: Generated<boolean>;
  created_at: CreatedAt;
}

export interface ApiKeysTable {
  id: Generated<string>;
  environment_id: string;
  kind: KeyKind;
  name: string;
  display_prefix: string;
  key_hash: Buffer;
  created_by: string | null;
  created_at: CreatedAt;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

export interface FlagsTable {
  id: Generated<string>;
  project_id: string;
  key: string;
  name: string;
  description: string;
  type: 'boolean' | 'string' | 'number' | 'json';
  variants: Json<Flag['variants']>;
  salt: string;
  client_side: boolean;
  version: Generated<number>;
  archived_at: Date | null;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface FlagConfigsTable {
  flag_id: string;
  environment_id: string;
  enabled: boolean;
  off_variant: string;
  prerequisites: Json<Flag['prerequisites']>;
  rules: Json<Flag['rules']>;
  fallthrough: Json<Flag['fallthrough']>;
  /** Targeting version in this environment; flags.version covers metadata. */
  version: Generated<number>;
  updated_at: UpdatedAt;
  /** The stage the nightly lifecycle check last saw; null until it has run. */
  lifecycle_stage: ColumnType<LifecycleStage | null, never, LifecycleStage>;
  lifecycle_checked_at: ColumnType<Date | null, never, Date>;
}

export interface SegmentsTable {
  id: Generated<string>;
  environment_id: string;
  key: string;
  name: string;
  description: string;
  included: Json<string[]>;
  excluded: Json<string[]>;
  rules: Json<Segment['rules']>;
  version: Generated<number>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/** A flag's settings, its targeting in one environment, or a segment. */
export type SnapshotKind = 'flag' | 'targeting' | 'segment';

export interface AuditLogTable {
  id: Generated<number>;
  project_id: string | null;
  environment_id: string | null;
  actor_id: string | null;
  actor_name: string;
  action: string;
  target_type: string;
  target_key: string;
  before: Json<unknown> | null;
  after: Json<unknown> | null;
  /** Why the change was made, as its author gave it. */
  reason: string | null;
  /** A ticket or incident link the author gave. */
  link: string | null;
  /** What `before` and `after` hold in full, on entries that changed something live. */
  snapshot: SnapshotKind | null;
  /** Generated from action, target, actor, reason and link; never written. */
  search: ColumnType<string, never, never>;
  created_at: CreatedAt;
}

export interface RulesetChangesTable {
  environment_id: string;
  version: number;
  kind: 'flag' | 'segment';
  key: string;
  value: Json<unknown> | null;
  checksum: string | null;
  created_at: CreatedAt;
}

export interface ScheduledChangesTable {
  id: Generated<string>;
  flag_id: string;
  environment_id: string;
  run_at: Date;
  change: Json<unknown>;
  status: Generated<ScheduleStatus>;
  error: string | null;
  created_by: string | null;
  created_by_name: string;
  created_at: CreatedAt;
  finished_at: Date | null;
}

export interface RolloutPlansTable {
  id: Generated<string>;
  flag_id: string;
  environment_id: string;
  plan: Json<unknown>;
  status: Generated<RolloutStatus>;
  /** Index of the step applied last. */
  step: Generated<number>;
  /** When the next step is due; set exactly when the plan is active. */
  next_at: Date | null;
  paused_reason: PausedReason | null;
  error: string | null;
  created_by: string | null;
  created_by_name: string;
  created_at: ColumnType<Date, Date | undefined, never>;
  /** Written from the app clock, like next_at, so holds are measured against one time source. */
  updated_at: ColumnType<Date, Date, Date>;
  finished_at: Date | null;
}

export interface ExposureCountsTable {
  environment_id: string;
  flag_key: string;
  variant: string;
  hour: Date;
  count: number;
}

export interface ExperimentExposuresTable {
  environment_id: string;
  flag_key: string;
  context_key: string;
  /** The variant the context was first served, which its conversions count towards. */
  variant: string;
  first_at: Date;
}

export interface ConversionEventsTable {
  environment_id: string;
  /** Chosen by the SDK, so a retried batch is stored once. */
  id: string;
  event_key: string;
  context_key: string;
  value: number | null;
  occurred_at: Date;
  received_at: Date;
}

export interface FlagEvaluationsTable {
  environment_id: string;
  flag_key: string;
  /** Start of the latest hour with an exposure, as the SDKs reported it. */
  last_evaluated_at: Date;
}

export interface LoginAttemptsTable {
  scope: 'email' | 'ip';
  key: string;
  /** Attempts inside the current window, oldest first, at most the scope's limit. */
  attempts: Date[];
  last_at: Date;
  /** Whether the most recent attempt was allowed; read back by the upsert. */
  allowed: Generated<boolean>;
}

export type ChangeRequestStatus = 'open' | 'applied' | 'closed';
export type ReviewDecision = 'comment' | 'approve' | 'request_changes';

export interface ChangeRequestsTable {
  id: Generated<string>;
  project_id: string;
  environment_id: string;
  /** The flag whose targeting this proposes; null for a segment request. */
  flag_id: string | null;
  /** The segment this proposes; null for a flag request. */
  segment_key: string | null;
  title: string;
  description: string;
  /** Version of the target that `base` was read at; 0 for a segment that didn't exist. */
  base_version: number;
  base: Json<unknown>;
  proposed: Json<unknown>;
  revision: Generated<number>;
  status: Generated<ChangeRequestStatus>;
  author_id: string | null;
  author_name: string;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
  finished_at: Date | null;
  finished_by_name: string | null;
  /** The reason the author proposed it with; the apply is recorded with it. */
  reason: string | null;
  link: string | null;
}

export interface ChangeRequestReviewsTable {
  id: Generated<number>;
  change_request_id: string;
  revision: number;
  reviewer_id: string | null;
  reviewer_name: string;
  decision: ReviewDecision;
  body: string;
  created_at: CreatedAt;
}

export interface Database {
  users: UsersTable;
  sessions: SessionsTable;
  projects: ProjectsTable;
  environments: EnvironmentsTable;
  api_keys: ApiKeysTable;
  flags: FlagsTable;
  flag_configs: FlagConfigsTable;
  segments: SegmentsTable;
  audit_log: AuditLogTable;
  ruleset_changes: RulesetChangesTable;
  scheduled_changes: ScheduledChangesTable;
  rollout_plans: RolloutPlansTable;
  exposure_counts: ExposureCountsTable;
  flag_evaluations: FlagEvaluationsTable;
  experiment_exposures: ExperimentExposuresTable;
  conversion_events: ConversionEventsTable;
  login_attempts: LoginAttemptsTable;
  change_requests: ChangeRequestsTable;
  change_request_reviews: ChangeRequestReviewsTable;
}
