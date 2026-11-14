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
  // Audit entries carry the reason and ticket link the author gave, and are
  // searchable by text, actor and date. `search` is a generated tsvector over
  // the words people search for (action, target, actor, reason, link) with
  // the 'simple' configuration, so keys and names match as typed rather than
  // stemmed. Separators inside keys, actions, tickets and URLs become spaces
  // first, so "checkout-v2", "kill_switch" and "INC-42" index as words the
  // search query (normalized the same way) can find as phrases. The listing pages by (created_at, id), newest first, so each
  // filter has an index in that order and a date range is an index range.
  // An environment can require a reason, a link or both on every change, and
  // a change request keeps the ones it was proposed with for its apply.
  '007_audit_search': statements([
    `ALTER TABLE audit_log
      ADD COLUMN reason text CHECK (length(reason) BETWEEN 1 AND 1000),
      ADD COLUMN link text CHECK (length(link) <= 2000 AND link ~ '^https?://')`,
    `ALTER TABLE audit_log ADD COLUMN search tsvector GENERATED ALWAYS AS (
      to_tsvector('simple', translate(
        action || ' ' || target_key || ' ' || actor_name || ' ' ||
          coalesce(reason, '') || ' ' || coalesce(link, ''),
        '.-_/:@#?&=+~%', '             '))
    ) STORED`,
    `CREATE INDEX audit_log_search_idx ON audit_log USING gin (search)`,
    `DROP INDEX audit_log_project_idx`,
    `DROP INDEX audit_log_target_idx`,
    `CREATE INDEX audit_log_project_idx ON audit_log (project_id, created_at DESC, id DESC)`,
    `CREATE INDEX audit_log_target_idx
      ON audit_log (project_id, target_type, target_key, created_at DESC, id DESC)`,
    `CREATE INDEX audit_log_actor_idx ON audit_log (project_id, actor_name, created_at DESC, id DESC)`,
    `ALTER TABLE environments
      ADD COLUMN require_reason boolean NOT NULL DEFAULT false,
      ADD COLUMN require_link boolean NOT NULL DEFAULT false`,
    `ALTER TABLE change_requests
      ADD COLUMN reason text CHECK (length(reason) BETWEEN 1 AND 1000),
      ADD COLUMN link text CHECK (length(link) <= 2000 AND link ~ '^https?://')`,
  ]),
  // Entries that changed something live say what their before and after
  // hold in full, so History can put it back: a flag's settings ('flag'), its
  // targeting in one environment ('targeting') or a segment ('segment'). A
  // null side means the target did not exist. Change request openings and
  // reviews carry a proposal rather than live state and stay null. Earlier
  // entries of these actions already stored full state, so they are marked too.
  '008_audit_snapshots': statements([
    `ALTER TABLE audit_log
      ADD COLUMN snapshot text CHECK (snapshot IN ('flag', 'targeting', 'segment'))`,
    `UPDATE audit_log SET snapshot = CASE
        WHEN action IN ('flag.create', 'flag.update') THEN 'flag'
        WHEN action IN ('segment.create', 'segment.update', 'segment.delete',
          'segment.change_request.apply') THEN 'segment'
        ELSE 'targeting'
      END
      WHERE action IN ('flag.create', 'flag.update', 'flag.config.update', 'flag.kill_switch',
        'flag.schedule.apply', 'flag.change_request.apply', 'segment.create', 'segment.update',
        'segment.delete', 'segment.change_request.apply')`,
  ]),
  // Lifecycle: when each flag was last evaluated in each environment, kept
  // from exposure flushes so stale detection doesn't scan hourly counts, and
  // backfilled from the counts already stored (hour precision). The nightly
  // lifecycle check stores the stage it last saw per flag and environment, so
  // a flag becoming stale, or no longer stale, is recorded once in History.
  '009_flag_lifecycle': statements([
    `CREATE TABLE flag_evaluations (
      environment_id uuid NOT NULL REFERENCES environments (id) ON DELETE CASCADE,
      flag_key text NOT NULL,
      last_evaluated_at timestamptz NOT NULL,
      PRIMARY KEY (environment_id, flag_key)
    )`,
    `INSERT INTO flag_evaluations (environment_id, flag_key, last_evaluated_at)
      SELECT environment_id, flag_key, max(hour) FROM exposure_counts GROUP BY 1, 2`,
    `ALTER TABLE flag_configs
      ADD COLUMN lifecycle_stage text
        CHECK (lifecycle_stage IN ('new', 'active', 'launched', 'inactive', 'archived')),
      ADD COLUMN lifecycle_checked_at timestamptz`,
    `CREATE INDEX flag_configs_lifecycle_due_idx ON flag_configs (lifecycle_checked_at NULLS FIRST)`,
  ]),
  // Progressive rollouts: a plan steps one serve of a flag in one environment
  // from a small share to everyone. `step` is the index of the step applied
  // last (the first is applied when the plan starts) and `next_at` is when the
  // scheduler loop applies the next one; only an active plan has one, so the
  // due index stays small. One live (active or paused) plan per flag and
  // environment, enforced here as well as under the environment lock.
  '010_rollout_plans': statements([
    `CREATE TABLE rollout_plans (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      flag_id uuid NOT NULL REFERENCES flags (id) ON DELETE CASCADE,
      environment_id uuid NOT NULL REFERENCES environments (id) ON DELETE CASCADE,
      plan jsonb NOT NULL,
      status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'paused', 'completed', 'cancelled', 'failed')),
      step integer NOT NULL DEFAULT 0 CHECK (step >= 0),
      next_at timestamptz,
      paused_reason text CHECK (paused_reason IN ('manual', 'kill_switch', 'edited')),
      error text CHECK (length(error) <= 1000),
      created_by uuid REFERENCES users (id) ON DELETE SET NULL,
      created_by_name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz,
      CHECK ((status = 'active') = (next_at IS NOT NULL)),
      CHECK ((status = 'paused') = (paused_reason IS NOT NULL))
    )`,
    `CREATE UNIQUE INDEX rollout_plans_live_idx ON rollout_plans (flag_id, environment_id)
      WHERE status IN ('active', 'paused')`,
    `CREATE INDEX rollout_plans_due_idx ON rollout_plans (next_at) WHERE status = 'active'`,
    `CREATE INDEX rollout_plans_flag_idx ON rollout_plans (flag_id, environment_id, created_at DESC)`,
  ]),
  // Experiment events. `experiment_exposures` keeps the first exposure of each
  // context to each flag (only contexts bucketed by a percentage split are
  // reported), so a conversion is attributed to the variant the context saw
  // first. The earliest report wins whatever order they arrive in, with the
  // variant key breaking a tie. `conversion_events` holds raw conversions; the
  // SDK gives each an id, so a retried batch doesn't count one twice.
  '011_experiment_events': statements([
    `CREATE TABLE experiment_exposures (
      environment_id uuid NOT NULL REFERENCES environments (id) ON DELETE CASCADE,
      flag_key text NOT NULL,
      context_key text NOT NULL CHECK (length(context_key) <= 1024),
      variant text NOT NULL,
      first_at timestamptz NOT NULL,
      PRIMARY KEY (environment_id, flag_key, context_key)
    )`,
    `CREATE TABLE conversion_events (
      environment_id uuid NOT NULL REFERENCES environments (id) ON DELETE CASCADE,
      id text NOT NULL CHECK (length(id) <= 64),
      event_key text NOT NULL,
      context_key text NOT NULL CHECK (length(context_key) <= 1024),
      value double precision,
      occurred_at timestamptz NOT NULL,
      received_at timestamptz NOT NULL,
      PRIMARY KEY (environment_id, id)
    )`,
    `CREATE INDEX conversion_events_context_idx
      ON conversion_events (environment_id, event_key, context_key, occurred_at)`,
  ]),
  // Hourly experiment rollups. Results are rolled up per cohort hour (the UTC
  // hour of a context's first exposure) and variant, so every context sits in
  // exactly one row and per-context sums of squares add up across hours.
  //
  // Writes mark what they touch from statement-level triggers, in the same
  // transaction as the data: an exposure insert or move marks the hours it
  // enters and leaves, and a conversion queues its context, which the worker
  // turns into hours against the exposures it can see. Marks are insert-only
  // (no unique key) so a writer never waits on a worker holding one, and the
  // worker deletes only the marks its snapshot sees.
  '012_experiment_rollups': statements([
    `CREATE INDEX experiment_exposures_context_idx
      ON experiment_exposures (environment_id, context_key, first_at)`,
    `CREATE INDEX experiment_exposures_hour_idx
      ON experiment_exposures (environment_id, flag_key, first_at)`,
    // The rollup joins conversions by context whatever the event, which this
    // serves as well as the per-event attribution query did with the old one.
    `DROP INDEX conversion_events_context_idx`,
    `CREATE INDEX conversion_events_context_idx
      ON conversion_events (environment_id, context_key, occurred_at)`,
    `CREATE TABLE experiment_rollup_dirty (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      environment_id uuid NOT NULL REFERENCES environments (id) ON DELETE CASCADE,
      flag_key text NOT NULL,
      hour timestamptz NOT NULL
    )`,
    `CREATE INDEX experiment_rollup_dirty_slice_idx
      ON experiment_rollup_dirty (environment_id, flag_key, hour)`,
    `CREATE TABLE experiment_rollup_pending (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      environment_id uuid NOT NULL REFERENCES environments (id) ON DELETE CASCADE,
      context_key text NOT NULL,
      first_occurred_at timestamptz NOT NULL,
      last_occurred_at timestamptz NOT NULL
    )`,
    `CREATE TABLE experiment_rollup_exposures (
      environment_id uuid NOT NULL REFERENCES environments (id) ON DELETE CASCADE,
      flag_key text NOT NULL,
      hour timestamptz NOT NULL,
      variant text NOT NULL,
      contexts integer NOT NULL CHECK (contexts > 0),
      PRIMARY KEY (environment_id, flag_key, hour, variant)
    )`,
    `CREATE TABLE experiment_rollup_conversions (
      environment_id uuid NOT NULL REFERENCES environments (id) ON DELETE CASCADE,
      flag_key text NOT NULL,
      event_key text NOT NULL,
      hour timestamptz NOT NULL,
      variant text NOT NULL,
      converted integer NOT NULL CHECK (converted > 0),
      conversions bigint NOT NULL,
      value_sum double precision NOT NULL,
      value_squares double precision NOT NULL,
      conversion_squares bigint NOT NULL,
      PRIMARY KEY (environment_id, flag_key, event_key, hour, variant)
    )`,
    `CREATE FUNCTION experiment_rollup_mark_inserted() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO experiment_rollup_dirty (environment_id, flag_key, hour)
        SELECT DISTINCT environment_id, flag_key, date_trunc('hour', first_at, 'UTC')
        FROM new_rows;
      RETURN NULL;
    END $$`,
    `CREATE FUNCTION experiment_rollup_mark_updated() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO experiment_rollup_dirty (environment_id, flag_key, hour)
        SELECT environment_id, flag_key, date_trunc('hour', first_at, 'UTC') FROM new_rows
        UNION
        SELECT environment_id, flag_key, date_trunc('hour', first_at, 'UTC') FROM old_rows;
      RETURN NULL;
    END $$`,
    `CREATE FUNCTION experiment_rollup_queue_conversions() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO experiment_rollup_pending
          (environment_id, context_key, first_occurred_at, last_occurred_at)
        SELECT environment_id, context_key, min(occurred_at), max(occurred_at)
        FROM new_rows GROUP BY environment_id, context_key;
      RETURN NULL;
    END $$`,
    `CREATE TRIGGER experiment_exposures_rollup_insert AFTER INSERT ON experiment_exposures
      REFERENCING NEW TABLE AS new_rows
      FOR EACH STATEMENT EXECUTE FUNCTION experiment_rollup_mark_inserted()`,
    `CREATE TRIGGER experiment_exposures_rollup_update AFTER UPDATE ON experiment_exposures
      REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
      FOR EACH STATEMENT EXECUTE FUNCTION experiment_rollup_mark_updated()`,
    `CREATE TRIGGER conversion_events_rollup_insert AFTER INSERT ON conversion_events
      REFERENCING NEW TABLE AS new_rows
      FOR EACH STATEMENT EXECUTE FUNCTION experiment_rollup_queue_conversions()`,
  ]),
  // Experiments. An experiment reads one flag's split in one environment
  // against a control variant and a list of conversion metrics; results come
  // from the hourly rollup for contexts first exposed while it ran. The split
  // it was started on is kept, so the sample ratio check has the weights the
  // traffic should follow. One running experiment per flag and environment.
  '013_experiments': statements([
    `CREATE TABLE experiments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
      environment_id uuid NOT NULL REFERENCES environments (id) ON DELETE CASCADE,
      flag_id uuid NOT NULL REFERENCES flags (id) ON DELETE CASCADE,
      key text NOT NULL,
      name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
      hypothesis text NOT NULL DEFAULT '' CHECK (length(hypothesis) <= 2000),
      target jsonb NOT NULL,
      allocation jsonb NOT NULL,
      control text NOT NULL,
      metrics jsonb NOT NULL,
      status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'stopped')),
      started_at timestamptz NOT NULL,
      stopped_at timestamptz,
      stopped_reason text CHECK (length(stopped_reason) <= 200),
      created_by uuid REFERENCES users (id) ON DELETE SET NULL,
      created_by_name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (project_id, key),
      CHECK ((status = 'stopped') = (stopped_at IS NOT NULL)),
      CHECK (stopped_at IS NULL OR stopped_at >= started_at)
    )`,
    `CREATE UNIQUE INDEX experiments_running_idx ON experiments (flag_id, environment_id)
      WHERE status = 'running'`,
    `CREATE INDEX experiments_project_idx ON experiments (project_id, created_at DESC, id DESC)`,
  ]),
};
