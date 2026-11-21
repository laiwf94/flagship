# Changelog

Notable changes to flagship. Each entry links the roadmap issue it belongs to.

## Unreleased

### Automation and integrations ([#29](https://github.com/laiwf94/flagship/issues/29), 2026-11-23 to 2026-11-29)

Upgrading runs five migrations (`014_event_bus`, `015_webhooks`, `016_webhook_replays`,
`017_api_tokens`, `018_rollout_guards`) on start. Webhooks need the new
`FLAGSHIP_SECRET_KEY` (32 bytes, base64); without it everything else works and creating a
webhook answers `409 failed_precondition`.

#### Added

- An internal event bus (`apps/server/src/events.ts`) on the audit log: each entry is
  stamped with its writing transaction, a statement trigger sends `pg_notify` at commit, so a
  rolled-back change publishes nothing, and readers take entries in `(tx, id)` order only
  from transactions that can no longer commit behind them, so nothing is skipped. Live
  handlers run on every instance; durable consumers keep a position in `event_consumers`
  and handle each event exactly once across instances, in the transaction that advances
  it. It reuses the stream hub's LISTEN connection. New metric
  `flagship_bus_events_total{consumer,result}`.
- Signed webhooks: `GET/POST/PATCH/DELETE /api/projects/:p/webhooks[/:id]` (admin), limited
  to one environment and to action patterns such as `flag.*`, at most 50 per project. The
  server generates each secret, shows it once and stores it sealed with AES-256-GCM;
  `POST .../webhooks/:id/secret` rotates it, with the old one also signing for 24 hours.
  A transactional outbox on the event bus writes one delivery per event and webhook, and a
  worker on every instance sends it with `Flagship-Signature: t=<unix>,v1=<HMAC-SHA256 of
"t.body">`, a 10-second deadline, no redirects and at most 64 KiB of response read,
  retrying with backoff (10 s up to hourly, `Retry-After` honoured) for 24 hours. Settings
  `FLAGSHIP_WEBHOOK_TIMEOUT_MS`, `_CONCURRENCY`, `_POLL_MS` and `_RETENTION_DAYS`; metrics
  `flagship_webhook_attempts_total{result}` and `flagship_webhook_attempt_duration_seconds`.
- A delivery log and replay: `GET .../webhooks/:id/deliveries` (keyset-paged, filtered by
  status and event) and `.../deliveries/:d` with the payload and every attempt;
  `POST .../deliveries/:d/replay` sends a finished delivery again as a new delivery with the
  same event id, and `POST .../webhooks/:id/replay` replays a time window once, at most 1000
  per call.
- `verifyWebhookSignature()` and `parseWebhook()` in `@flagship/node`: the raw body, one
  secret or several, a 5-minute tolerance either way, constant-time comparison, and a
  `WebhookSignatureError` with a `code` on failure.
- Scoped, expiring API tokens: `GET/POST /api/tokens` and `DELETE /api/tokens/:id`, managed
  under Settings. A `fst_` token (stored hashed, shown once) carries scopes such as
  `flags:write` or `audit:read`, an optional project and environments, and a required expiry
  of 1 to 365 days. Bearer requests need no cookie or CSRF token; every `/api` route
  declares its scope or that it is session-only, and the server refuses to start otherwise.
  The owner's current role still applies, so demoting or disabling them narrows or ends
  their tokens, and changes are audited as `<user> (token <name>)`.
- Guarded rollouts: a rollout plan takes up to five guards, each an event tracked by the
  SDKs, measured as a conversion, count or value per exposed context, with the bad
  direction, a relative threshold, a minimum of contexts per side and `pause` or `rollback`.
  After every rollup turn `services/guards.ts` checks guarded plans with 99% delta-method
  intervals; on a breach it pauses the plan or writes the baseline back through the normal
  write path and ends the plan as `rolled_back`, storing the readings on the plan and in a
  `flag.rollout.guard` audit entry, which webhooks receive. A hand-edited serve is never
  overwritten. `GET .../rollout-plans/:id/guards` reads them now; the Rollout tab edits and
  explains them. New metric `flagship_rollout_guard_checks_total{result}`.
- `examples/demo.sh` adds a webhook receiver on the Docker host
  (`examples/node-app/receiver.mjs`) that verifies every delivery with `parseWebhook()`,
  refuses forged and unsigned requests with `401` and recognises a replay by its event id,
  and a guarded rollout whose checkout app (`examples/node-app/checkout.mjs`) fails ten
  times as often on the new path, so the guard rolls the plan back within seconds and the
  receiver verifies the guard and rollback events. The compose stack sets a demo-only
  `FLAGSHIP_SECRET_KEY` and allow-lists `host.docker.internal` for webhooks.

#### Security

- Webhook targets are checked after DNS resolution, at connect time: loopback, private,
  link-local (including cloud metadata), carrier-grade NAT, multicast, reserved and
  documentation ranges, and IPv6 forms that embed them are refused, so DNS rebinding can't
  reach them either. Literal addresses and `localhost` are refused with `400` when saving.
  `FLAGSHIP_WEBHOOK_ALLOWED_TARGETS` lists addresses, CIDR ranges or host names to allow
  for self-hosted receivers.

#### Fixed

- `welchTTest` returned non-finite degrees of freedom, and threw, at very small or very
  large variances ([#83](https://github.com/laiwf94/flagship/issues/83)).
- Live event handlers could receive events committed before they registered, behind an older
  open transaction ([#86](https://github.com/laiwf94/flagship/issues/86)).

### Experiments ([#28](https://github.com/laiwf94/flagship/issues/28), 2026-11-16 to 2026-11-22)

Upgrading runs four migrations (`010_rollout_plans`, `011_experiment_events`,
`012_experiment_rollups`, `013_experiments`) on start.

#### Added

- Progressive rollouts: `POST .../flags/:flag/environments/:env/rollout-plans` starts a plan
  that steps a variant over a baseline on the default rule or one rule, through growing
  weights to 100%, holding each step for 1 minute to 30 days. The first step applies at once
  and the scheduler applies each later one exactly once across instances. Turning the flag
  off pauses the plan, a hand edit to the targeted serve pauses it rather than being
  overwritten, and `.../rollout-plans/:id/pause`, `/resume` and `/cancel` control it by hand.
  Stickiness holds across steps. The flag page has a Rollout tab to start, follow and control
  one, and `flagship_rollout_steps_total` counts steps by outcome.
- Conversion events: `track(event, context, value?)` in `@flagship/node` and
  `track(event, value?)` in `@flagship/browser` queue conversions with an id, so a retried
  batch is stored once. SDKs also report each context's first exposure to a percentage split,
  once per context and flag. `POST /sdk/v1/events` takes both as new `exposures` and
  `conversions` lists next to the counts (1,000 items in all) and refuses a request whole
  with `429` when its queue is full. The server keeps the earliest exposure per context in
  `experiment_exposures`, whatever order reports arrive in, and attributes conversions to
  it inside a window. SDK buffers are bounded by `maxEvents` (`droppedEvents` counts what
  didn't fit), and `flagship_experiment_events_total` and
  `flagship_experiment_queue_entries` are new metrics.
- Hourly experiment rollups: results per variant and cohort hour (the hour of each
  context's first exposure), with exposed and converted contexts, conversions, value sums
  and per-context sums of squares for variance, counting conversions within 7 days of the
  first exposure. Writes mark the hours they touch from triggers in the same transaction,
  and every instance's scheduler loop recomputes marked hours from the raw events, each
  exactly from one snapshot, so any number of instances agree. Runs every
  `FLAGSHIP_ROLLUP_INTERVAL_MS` (60000); `flagship_experiment_rollups_total` counts hours
  rolled up and yielded.
- `@flagship/stats`, a dependency-free statistics package for experiment results: normal,
  chi-square and Student's t distributions (density, both tails, quantiles), Welch's t-test
  with an interval for the difference, delta-method intervals for relative lift and ratio
  metrics, Wilson intervals for rates, and a chi-square sample ratio mismatch check
  (p < 0.001 by default). `summarize()` reads a variant straight from the hourly rollup's
  sums. Checked against tabulated critical values and SciPy.
- Experiments: `POST /api/projects/:p/experiments` starts one on a flag's live percentage
  split (the default rule or one rule) with a control variant and up to ten metrics, each a
  conversion rate, a count or a value per exposed context; one runs per flag and
  environment, `.../experiments/:x/stop` stops it, and archiving the flag stops it too.
  `GET .../experiments/:x/results` reports each variant's mean with a 95% interval (Wilson
  for rates, t otherwise) and the difference and lift over the control with Welch's p-value,
  from the hourly rollup for contexts first exposed while it ran. A chi-square sample ratio
  check against the recorded split runs first; below p = 0.001 the metrics are withheld
  behind a `sample_ratio_mismatch` warning unless `?showMismatched=true`. `allocationChanged`
  says when the live split no longer matches.
- `examples/demo.sh` runs two seeded experiments through the Node SDK on the Docker stack and
  checks the results route: one with a known +50% effect (10% to 15%), reported with exact
  counts and a lift interval around it, and one that loses one in five treatment exposures,
  whose results the sample ratio check hides behind its warning. The compose stack rolls
  results up every 5 seconds (`FLAGSHIP_ROLLUP_INTERVAL_MS`).

#### Fixed

- A targeting write and the lifecycle check running at once could deadlock, failing one of
  them ([#81](https://github.com/laiwf94/flagship/issues/81)).
- Flushing the exposure or experiment event queue while a timer flush was running returned
  before records added since that flush started were written, so shutdown could lose them
  ([#82](https://github.com/laiwf94/flagship/issues/82)).

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
