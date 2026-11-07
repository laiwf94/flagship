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
  // Targeting gets its own version per environment, so edits to development
  // and production of one flag no longer conflict. flags.version stays as the
  // metadata version. The backfill copies the flag's version so an editor who
  // loaded the flag before the upgrade can still save.
  '003_flag_config_versions': statements([
    `ALTER TABLE flag_configs ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version >= 1)`,
    `UPDATE flag_configs SET version = flags.version
      FROM flags WHERE flags.id = flag_configs.flag_id AND flags.version <> 1`,
  ]),
  // Each recorded change carries the checksum of the ruleset as of that
  // version, so SDKs can verify every patch. Older rows have none and are
  // sent without one; SDKs skip the check for those.
  '004_ruleset_change_checksums': statements([
    `ALTER TABLE ruleset_changes ADD COLUMN checksum text CHECK (checksum ~ '^[0-9a-f]{64}$')`,
  ]),
  // Change requests: a proposed targeting change to one flag in one
  // environment, its reviews, and how many approvals an environment needs.
  // An environment that needs one or more takes targeting changes only
  // through approved requests. `revision` goes up whenever the proposal
  // changes (a rebase), and a review counts only for the revision it saw.
  '005_change_requests': statements([
    `ALTER TABLE environments ADD COLUMN required_approvals smallint NOT NULL DEFAULT 0
      CHECK (required_approvals BETWEEN 0 AND 5)`,
    `CREATE TABLE change_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
      environment_id uuid NOT NULL REFERENCES environments (id) ON DELETE CASCADE,
      flag_id uuid NOT NULL REFERENCES flags (id) ON DELETE CASCADE,
      title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
      description text NOT NULL DEFAULT '' CHECK (length(description) <= 4000),
      base_version integer NOT NULL CHECK (base_version >= 1),
      base jsonb NOT NULL,
      proposed jsonb NOT NULL,
      revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
      status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'applied', 'closed')),
      author_id uuid REFERENCES users (id) ON DELETE SET NULL,
      author_name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz,
      finished_by_name text
    )`,
    `CREATE INDEX change_requests_project_idx ON change_requests (project_id, created_at DESC, id DESC)`,
    `CREATE INDEX change_requests_target_idx ON change_requests (flag_id, environment_id)
      WHERE status = 'open'`,
    `CREATE TABLE change_request_reviews (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      change_request_id uuid NOT NULL REFERENCES change_requests (id) ON DELETE CASCADE,
      revision integer NOT NULL,
      reviewer_id uuid REFERENCES users (id) ON DELETE SET NULL,
      reviewer_name text NOT NULL,
      decision text NOT NULL CHECK (decision IN ('comment', 'approve', 'request_changes')),
      body text NOT NULL DEFAULT '' CHECK (length(body) <= 4000),
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX change_request_reviews_request_idx ON change_request_reviews (change_request_id, id)`,
  ]),
  // A change request targets a flag's targeting or a segment. Segments are
  // per environment and can be created or deleted through a request, so the
  // target is the segment key, the base or proposal is JSON null when the
  // segment is absent on that side, and base version 0 means it didn't exist.
  '006_segment_change_requests': statements([
    `ALTER TABLE change_requests ALTER COLUMN flag_id DROP NOT NULL`,
    `ALTER TABLE change_requests ADD COLUMN segment_key text`,
    `ALTER TABLE change_requests ADD CONSTRAINT change_requests_one_target
      CHECK ((flag_id IS NULL) <> (segment_key IS NULL))`,
    `ALTER TABLE change_requests DROP CONSTRAINT change_requests_base_version_check`,
    `ALTER TABLE change_requests ADD CONSTRAINT change_requests_base_version_check
      CHECK (base_version >= 0 AND (base_version >= 1 OR segment_key IS NOT NULL))`,
    `CREATE INDEX change_requests_segment_idx ON change_requests (environment_id, segment_key)
      WHERE status = 'open' AND segment_key IS NOT NULL`,
  ]),
};
