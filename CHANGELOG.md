# Changelog

Notable changes to flagship. Each entry links the roadmap issue it belongs to.

## Unreleased

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
