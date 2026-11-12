# Changelog

Notable changes to flagship. Each entry links the roadmap issue it belongs to.

## Unreleased

### Experiments ([#28](https://github.com/laiwf94/flagship/issues/28), 2026-11-16 to 2026-11-22)

Upgrading runs one migration (`010_rollout_plans`) on start.

#### Added

- Progressive rollouts: `POST .../flags/:flag/environments/:env/rollout-plans` starts a plan
  that steps a variant over a baseline on the default rule or one rule, through growing
  weights to 100%, holding each step for 1 minute to 30 days. The first step applies at once
  and the scheduler applies each later one exactly once across instances. Turning the flag
  off pauses the plan, a hand edit to the targeted serve pauses it rather than being
  overwritten, and `.../rollout-plans/:id/pause`, `/resume` and `/cancel` control it by hand.
  Stickiness holds across steps. The flag page has a Rollout tab to start, follow and control
  one, and `flagship_rollout_steps_total` counts steps by outcome.

#### Fixed

- A targeting write and the lifecycle check running at once could deadlock, failing one of
  them ([#81](https://github.com/laiwf94/flagship/issues/81)).

### Safe changes ([#27](https://github.com/laiwf94/flagship/issues/27), 2026-11-09 to 2026-11-15)

Upgrading runs five migrations (`005_change_requests`, `006_segment_change_requests`,
`007_audit_search`, `008_audit_snapshots`, `009_flag_lifecycle`) on start. Clients paging the
audit log with `before=<id>` need to send the `cursor` from the previous page instead (see
Changed).

#### Added

- Protected environments and change requests: `PUT .../environments/:env/approvals` (admins,
  0 to 5). Above zero, targeting edits, segment writes and new scheduled changes there are
  refused with `403` and go through change requests instead; the kill switch still works
  directly, for incidents. A request proposes a flag's whole targeting
  (`POST .../flags/:flag/environments/:env/change-requests`) or a segment create, edit or
  delete (`POST .../environments/:env/segments/:segment/change-requests`) against a live base
  version. Reviews (comment, approve, request changes) count for the revision they saw, and
  authors can't approve or reject their own request. Apply needs `max(1, required)` approvers
  and no standing request for changes, and of concurrent applies only one lands. A stale
  request shows a three-way merge of base, proposal and live; rebase writes it as a new
  revision that needs approving again. Routes for list, read, reviews, apply, rebase and close,
  and a new error code `failed_precondition` (`409`).
- The console's Changes list and review page (diff, rollout preview, discussion by revision,
  apply, rebase and close), and proposing from the targeting and segment editors in a
  protected environment.
- Change reasons and links: every write takes `Flagship-Reason` (percent-encoded UTF-8) and
  `Flagship-Link` headers, recorded on its audit entry. `PUT .../environments/:env/change-notes`
  makes either mandatory per environment, and the console asks for them in every dialog that
  writes there, with the rule set in Settings.
- Audit search: `GET .../audit` takes `flag`, `segment`, `actor`, `q` (web-search syntax over
  action, target, actor, reason and link, on a GIN-indexed `tsvector`), `from`, `to`, `cursor`
  and `limit`, with keyset paging on `(created_at, id)`. History has the same filters, kept in
  the URL. `pnpm bench:audit` seeds 1,000,000 entries and fails if any query's p95 reaches
  50 ms; on 4 vCPUs every p95 is between 0.9 and 2.8 ms.
- Rollback: every entry that changed a flag, its targeting or a segment holds the whole state
  before and after (`snapshot`). `GET .../audit/:id/restore?to=before|after` reviews a restore
  as a diff against live, and `POST` applies it against that live version, or opens a change
  request in a protected environment. History has a Restore action.
- Flag lifecycle: `@flagship/core` `lifecycleOf` gives each flag `new`, `active`, `launched`
  (one variant for everyone and untouched for 30 days), `inactive` (not evaluated for 30
  days) or `archived`, with the reasons. Last evaluation is tracked from exposures in
  `flag_evaluations`; an hourly job, shared between instances, records `flag.lifecycle`
  entries when a flag becomes stale or stops being stale and exports
  `flagship_flags_lifecycle` and `flagship_lifecycle_transitions_total`. The flag list returns
  `lifecycle` and `lastEvaluatedAt`, `GET .../environments/:env/stale-flags` lists stale flags,
  and the console shows lifecycle chips and a Cleanup view.
- `examples/demo.sh` ends with an incident drill on a protected production: a bad change goes
  out through an approved change request, History search finds it, and a restore puts it back
  through a second change request, with self-approvals refused and checksums compared on the
  app and both instances.

#### Changed

- `GET .../audit` pages with an opaque `cursor` (the previous page's `next`) instead of
  `before=<id>`, so entries with the same timestamp are neither skipped nor repeated.
- Entries in the audit listing carry `reason`, `link` and `restorable`.

### Correctness under many instances ([#26](https://github.com/laiwf94/flagship/issues/26), 2026-11-02 to 2026-11-08)

Upgrading runs three migrations (`002_login_attempts`, `003_flag_config_versions`,
`004_ruleset_change_checksums`) on start. Editors that still send the flag's version when
saving targeting need to send the environment's version instead (see Changed).

#### Added

- One sign-in budget for every instance: failed sign-ins are counted in the new
  `login_attempts` table, 10 per email and 50 per address in a sliding 15 minutes, with one
  `INSERT ... ON CONFLICT ... RETURNING` per attempt, so concurrent guesses across instances
  can't overrun it. A refused attempt doesn't extend the lockout. The scheduler prunes expired
  rows, 1,000 at a time.
- Ruleset checksums: canonical JSON (RFC 8785) and SHA-256 in `@flagship/core`.
  `GET /sdk/v1/ruleset`, the stream's `put` and every `patch` carry the checksum of the whole
  ruleset, and `POST /sdk/v1/evaluate` a checksum of its values. The Node SDK verifies every
  snapshot and patch, keeps its last verified ruleset on a mismatch or an invalid patch, and
  reconnects for a full snapshot with backoff; it exposes `checksum`, `resyncs` and
  `ChecksumError`. The browser SDK verifies answers with WebCrypto and refetches on a mismatch.
  A new conformance case file pins the checksums.
- Project export and import: `GET /api/projects/:p/export` streams the whole project (every
  flag with its targeting in each environment, segments, and each environment's checksum) from
  one consistent snapshot. `POST /api/projects/import?key=&name=` checks the whole document
  before writing anything and creates the project, or a copy under another key, in one
  transaction. Both are admin only. `FLAGSHIP_IMPORT_MAX_MB` (32) limits the import body.
- A fault-injection suite in `apps/server/test/faults`: two server processes behind a load
  balancer with 40 SDKs evaluating through it, with pooled Postgres connections cut, LISTEN
  sessions cut and an instance SIGKILLed. It runs in `pnpm test` with 3 rounds per fault.
- `pnpm bench:faults` writes recovery times to `bench/results/faults.json` (schema 1). Median
  time until every SDK serves a change made right after the fault: 103 ms with pooled
  connections cut, 1,015 ms with LISTEN sessions cut, 1,038 ms with an instance killed. No
  evaluation fell back to a default. A nightly workflow re-runs it with 10 rounds per fault and
  keeps the report for 90 days.
- `examples/demo.sh` runs two instances (the new `multi` compose profile adds one on port 8081) and checks the shared sign-in budget, per-environment versions, matching checksums on
  the app and both instances, recovery from a killed instance, and an export imported as a copy.

#### Changed

- Each environment's targeting has its own version (`flag_configs.version`, backfilled from
  the flag's). `PUT .../flags/:f/environments/:e` takes that environment's version, which
  `GET` on a flag returns as `environments.<env>.version`, so editing development no longer
  conflicts with an edit to production. The flag's own `version` now covers only its name,
  description, variants and archive state. SDKs still see a version that goes up by one with
  every change to their environment.
- `POST /api/session` fails closed: if the sign-in budget can't be checked it answers `503`
  with `Retry-After: 5` and issues no session.

#### Fixed

- A Postgres connection terminated while a client was checked out from the pool (between
  statements of a transaction, for example) crashed the server with an unhandled `error`
  event. The request now fails and the pool replaces the connection. Found by the fault suite.

#### Security

- glob 14.0.3 and minimatch 11.0.4, for an AbortSignal bypass and a denial of service on
  crafted patterns ([#79](https://github.com/laiwf94/flagship/issues/79)).

## 0.1.0 (2026-10-25)

The first version: flags with boolean, string, number and JSON variants per environment;
targeting rules, segments, sticky percentage rollouts, prerequisites, a kill switch and
scheduled changes; a linear-time regex engine; ruleset snapshots and SSE streaming with resume
and ETag polling; a Node SDK with an OpenFeature provider and a browser SDK; exposure counts
with backpressure; users, roles, cookie sessions with CSRF protection and an audit log; a
React admin UI; the conformance suite; and a Docker image with a compose stack.
