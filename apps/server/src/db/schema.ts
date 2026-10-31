import type { Flag, Segment } from '@flagship/core';
import type { ColumnType, Generated } from 'kysely';

type CreatedAt = ColumnType<Date, never, never>;
type UpdatedAt = ColumnType<Date, never, Date>;
type Json<T> = ColumnType<T, string, string>;

export type Role = 'viewer' | 'editor' | 'admin';
export type KeyKind = 'server' | 'client';
export type ScheduleStatus = 'pending' | 'applied' | 'failed' | 'cancelled';

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
  updated_at: UpdatedAt;
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
  created_at: CreatedAt;
}

export interface RulesetChangesTable {
  environment_id: string;
  version: number;
  kind: 'flag' | 'segment';
  key: string;
  value: Json<unknown> | null;
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

export interface ExposureCountsTable {
  environment_id: string;
  flag_key: string;
  variant: string;
  hour: Date;
  count: number;
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
  exposure_counts: ExposureCountsTable;
  login_attempts: LoginAttemptsTable;
}
