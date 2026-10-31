import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

// node-postgres sends parameterised queries through the extended protocol,
// which allows one statement per query, so each migration is a list.
function statements(list: readonly string[]): Migration {
  return {
    async up(db: Kysely<unknown>) {
      for (const statement of list) await sql.raw(statement).execute(db);
    },
  };
}

export const migrations: Record<string, Migration> = {
  '001_initial': statements([
    `CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text NOT NULL UNIQUE CHECK (email = lower(email) AND length(email) <= 254),
      name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
      password_hash text NOT NULL,
      role text NOT NULL CHECK (role IN ('viewer', 'editor', 'admin')),
      disabled_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE sessions (
      token_hash bytea PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      csrf_token text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL
    )`,
    `CREATE INDEX sessions_user_idx ON sessions (user_id)`,
    `CREATE INDEX sessions_expires_idx ON sessions (expires_at)`,
    `CREATE TABLE projects (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      key text NOT NULL UNIQUE,
      name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE environments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
      key text NOT NULL,
      name text NOT NULL,
      ruleset_version bigint NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (project_id, key)
    )`,
    `CREATE TABLE api_keys (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      environment_id uuid NOT NULL REFERENCES environments (id) ON DELETE CASCADE,
      kind text NOT NULL CHECK (kind IN ('server', 'client')),
      name text NOT NULL,
      display_prefix text NOT NULL,
      key_hash bytea NOT NULL UNIQUE,
      created_by uuid REFERENCES users (id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_used_at timestamptz,
      revoked_at timestamptz
    )`,
    `CREATE INDEX api_keys_environment_idx ON api_keys (environment_id)`,
    `CREATE TABLE flags (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
      key text NOT NULL,
      name text NOT NULL,
      description text NOT NULL DEFAULT '',
      type text NOT NULL CHECK (type IN ('boolean', 'string', 'number', 'json')),
      variants jsonb NOT NULL,
      salt text NOT NULL,
      client_side boolean NOT NULL DEFAULT false,
      version integer NOT NULL DEFAULT 1,
      archived_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (project_id, key)
    )`,
    `CREATE TABLE flag_configs (
      environment_id uuid NOT NULL REFERENCES environments (id) ON DELETE CASCADE,
      flag_id uuid NOT NULL REFERENCES flags (id) ON DELETE CASCADE,
      enabled boolean NOT NULL DEFAULT false,
      off_variant text NOT NULL,
      prerequisites jsonb NOT NULL DEFAULT '[]',
      rules jsonb NOT NULL DEFAULT '[]',
      fallthrough jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (environment_id, flag_id)
    )`,
    `CREATE INDEX flag_configs_flag_idx ON flag_configs (flag_id)`,
    `CREATE TABLE segments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      environment_id uuid NOT NULL REFERENCES environments (id) ON DELETE CASCADE,
      key text NOT NULL,
      name text NOT NULL,
      description text NOT NULL DEFAULT '',
      included jsonb NOT NULL DEFAULT '[]',
      excluded jsonb NOT NULL DEFAULT '[]',
      rules jsonb NOT NULL DEFAULT '[]',
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (environment_id, key)
    )`,
    `CREATE TABLE audit_log (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      project_id uuid REFERENCES projects (id) ON DELETE CASCADE,
      environment_id uuid REFERENCES environments (id) ON DELETE SET NULL,
      actor_id uuid REFERENCES users (id) ON DELETE SET NULL,
      actor_name text NOT NULL,
      action text NOT NULL,
      target_type text NOT NULL,
      target_key text NOT NULL,
      before jsonb,
      after jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX audit_log_project_idx ON audit_log (project_id, id DESC)`,
    `CREATE INDEX audit_log_target_idx ON audit_log (project_id, target_type, target_key, id DESC)`,
    `CREATE TABLE ruleset_changes (
      environment_id uuid NOT NULL REFERENCES environments (id) ON DELETE CASCADE,
      version bigint NOT NULL,
      kind text NOT NULL CHECK (kind IN ('flag', 'segment')),
      key text NOT NULL,
      value jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (environment_id, version)
    )`,
    `CREATE TABLE scheduled_changes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      flag_id uuid NOT NULL REFERENCES flags (id) ON DELETE CASCADE,
      environment_id uuid NOT NULL REFERENCES environments (id) ON DELETE CASCADE,
      run_at timestamptz NOT NULL,
      change jsonb NOT NULL,
      status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'applied', 'failed', 'cancelled')),
      error text,
      created_by uuid REFERENCES users (id) ON DELETE SET NULL,
      created_by_name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz
    )`,
    `CREATE INDEX scheduled_changes_due_idx ON scheduled_changes (run_at) WHERE status = 'pending'`,
    `CREATE INDEX scheduled_changes_flag_idx ON scheduled_changes (flag_id, environment_id)`,
    `CREATE TABLE exposure_counts (
      environment_id uuid NOT NULL REFERENCES environments (id) ON DELETE CASCADE,
      flag_key text NOT NULL,
      hour timestamptz NOT NULL,
      variant text NOT NULL,
      count bigint NOT NULL CHECK (count >= 0),
      PRIMARY KEY (environment_id, flag_key, hour, variant)
    )`,
  ]),
  '002_login_attempts': statements([
    `CREATE TABLE login_attempts (
      scope text NOT NULL CHECK (scope IN ('email', 'ip')),
      key text NOT NULL CHECK (length(key) <= 320),
      attempts timestamptz[] NOT NULL,
      last_at timestamptz NOT NULL,
      allowed boolean NOT NULL DEFAULT true,
      PRIMARY KEY (scope, key)
    )`,
    `CREATE INDEX login_attempts_last_at_idx ON login_attempts (last_at)`,
  ]),
};
