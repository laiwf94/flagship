# flagship

A feature-flag and gradual-rollout service: you define flags and targeting rules in an
admin UI or API, and your apps evaluate them locally through an SDK that stays in sync
over Server-Sent Events. Rollouts are sticky, so growing one from 10% to 50% only ever
adds people, and a kill switch turns a feature off everywhere within milliseconds.

Written in TypeScript: a Fastify server on PostgreSQL, a React admin UI, a Node SDK with
an [OpenFeature](https://openfeature.dev) provider, and a browser SDK, all sharing one
evaluation package.

```ts
import { FlagshipClient } from '@flagship/node';

const flags = new FlagshipClient({
  sdkKey: process.env.FLAGSHIP_SDK_KEY!,
  baseUrl: 'https://flags.internal',
});
await flags.ready();

// A function call against the in-memory ruleset: no network, about half a microsecond.
if (
  flags.boolVariation(
    'new-checkout',
    { key: user.id, plan: user.plan, country: user.country },
    false,
  )
) {
  return renderNewCheckout();
}
```

![Flag editor with a rule builder and a live preview of who gets what](docs/screenshots/flag-targeting-1440.png)

## Flags, rules and rollouts

A flag has boolean, string, number or JSON variants and is configured separately in each
environment. Targeting rules look at attributes of the context: equality and lists, string
tests, number and semantic-version comparisons, and regular expressions. A linear-time engine
runs the patterns, so a bad one can't hang an SDK. Rules can also point at reusable segments,
which have include and exclude lists.

Percentage rollouts use consistent hashing. The same user gets the same variant on every
server, and raising the percentage never moves anyone out. You can bucket by user, or by any
attribute such as an organisation. Each flag also has a kill switch, prerequisites on other
flags (cycles are rejected), and scheduled changes that apply on time and exactly once, however
many server instances are running. A progressive rollout steps a variant from a small share to
everyone on its own (1%, 5%, 10%, 25%, 50%, 100% by default, each held as long as you choose),
each step exactly once across instances; turning the flag off pauses it, and nobody who has the
new variant loses it at a later step.

Server SDKs evaluate locally from a ruleset snapshot, kept current over SSE with resume
(`Last-Event-ID`) and ETag polling as a fallback. Every snapshot and every patch carries a
checksum of the whole ruleset; an SDK that ends up with something else, after a lost or
garbled patch, keeps its last good ruleset and fetches a fresh one. When the service is down,
apps keep the last ruleset or fall back to their own defaults. Browsers use client-side keys,
which get evaluated values only, never rules or other users, and those answers are
checksummed too.

Editing is versioned, and a stale edit gets `409`. A flag's metadata and its targeting in
each environment have separate versions, so editing development never conflicts with an edit
to production. The whole ruleset is validated before a
change commits, and the UI shows a diff and a live preview of who would change variant before
you save. An audit log records every change and who made it. Access uses three roles (viewer,
editor, admin) and cookie sessions with CSRF protection, and each environment has its own
server and client keys, stored hashed. Failed sign-ins are limited per email and per address
from one budget in Postgres, so adding instances doesn't add guesses, and if that budget
can't be checked, sign-in answers `503` rather than letting the attempt through. SDKs also
report which variants they served, batched and with backpressure, and the UI shows the counts
per variant. For experiments, `track('purchase', context, 25)` records a conversion, and
SDKs report each context's first exposure to a percentage split once, so a conversion counts
for the variant that context saw first.

A whole project exports to one JSON document (flags, targeting in every environment and
segments, with each environment's checksum) and imports back into a new project, or a copy
under another key. The import checks everything before it writes anything, and the copy serves
rulesets with the same checksums as the original.

## Running it locally

```console
$ docker compose up -d --build --wait     # Postgres + flagship on http://localhost:8080
$ ./examples/demo.sh                      # two instances, a Node app following a flag live
```

Sign in at <http://localhost:8080> as `admin@example.com` with the demo password from
`docker-compose.yml`. A fresh install has a `default` project with development and production
environments. Create a server key under Settings, then point an SDK at it.

The demo starts a second instance on <http://localhost:8081> (the compose profile `multi`),
makes every change through the first and runs a small Node app on the second, then prints
each step's evidence as it checks it:

- ten wrong passwords for one email, alternating between the instances, get `401`; the next
  attempt gets `429` from both;
- the app sees 0/1000 users on, then about 100 after a 10% rollout;
- development and production are saved from one load of the flag without a conflict, and a
  second save with the same production version gets `409`;
- at 50% about 500 users are on, and every user from the 10% step is still on;
- the app, the first instance and the second report the same ruleset checksum;
- the second instance is SIGKILLed, the kill switch is saved on the first, and when the
  second starts again the app reconnects, resumes and serves 0/1000, on the same checksum;
- the project is exported, imported under a new key, and the copy's checksums match;
- an incident drill on a protected production (one approval, a reason and a ticket link
  required): a direct edit gets `403`; a second user's change request turns the flag on for
  everyone, its author's own approval gets `403` and an unapproved apply `409`, and once an
  admin approves and it is applied the app serves 1000/1000; History search by text, actor
  and time finds the applied change; restoring it opens a change request the restorer can't
  approve, and once the other user approves it the app is back at 0/1000 on the same checksum
  as both instances. Production is unprotected again at the end, and a run that stopped
  half-way through the drill is cleaned up by the next one.

It fails if any check doesn't hold or the app doesn't print a step in time (15 seconds, 60
for the restart). Stop the stack with `docker compose --profile multi down -v`.

Working on flagship itself needs Node 22, pnpm and Docker.

```console
$ pnpm install
$ pnpm check            # format, lint, typecheck, tests with coverage (Postgres via Testcontainers)
$ pnpm e2e              # build, then Playwright + axe against the real server and UI
$ pnpm --filter @flagship/admin dev   # UI on :5173, proxying to a server on :8080
```

## SDKs

| Package                      | For         | How it works                                                                                                                                |
| ---------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `@flagship/node`             | servers     | holds the ruleset, evaluates locally, SSE with resume, ETag polling fallback, exposure and `track()` batching                               |
| `@flagship/node/openfeature` | OpenFeature | `OpenFeature.setProvider(new FlagshipProvider({ sdkKey, baseUrl }))`                                                                        |
| `@flagship/browser`          | web apps    | client key; the server evaluates the user's context and the SDK caches the values for synchronous reads; refetches when the version changes |
| `@flagship/core`             | everything  | model, validation, evaluator; also used by the admin UI's preview                                                                           |

## HTTP API

Admin routes use the session cookie and need `X-CSRF-Token` on writes. Any write can carry
`Flagship-Reason` (percent-encoded) and `Flagship-Link` headers, recorded on its audit entry.
SDK routes take `Authorization: Bearer <key>`.

| Endpoint                                                                    | Purpose                                                                                      |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `POST /api/session`, `GET /api/session`, `DELETE /api/session`              | sign in (returns the CSRF token), current user, sign out                                     |
| `PUT /api/session/password`                                                 | change password, ending other sessions                                                       |
| `GET/POST /api/users`, `PATCH /api/users/:id`                               | people and roles (admin)                                                                     |
| `GET/POST /api/projects`, `POST /api/projects/:p/environments`              | projects and environments                                                                    |
| `GET/POST/DELETE /api/projects/:p/environments/:e/api-keys[/:id]`           | SDK keys; the secret is returned once (admin)                                                |
| `GET /api/projects/:p/export`                                               | the whole project as one JSON document, streamed (admin)                                     |
| `POST /api/projects/import?key=&name=`                                      | create a project from an export, validated first (admin)                                     |
| `GET/POST /api/projects/:p/flags`                                           | list with `q`, `status`, `type` filters; create                                              |
| `GET/PUT /api/projects/:p/flags/:f`                                         | read; edit name, description, variants (with `version`)                                      |
| `PUT /api/projects/:p/flags/:f/environments/:e`                             | replace targeting (with that environment's `version`)                                        |
| `POST /api/projects/:p/flags/:f/environments/:e/kill-switch`                | `{"enabled": false}`, no version needed                                                      |
| `POST /api/projects/:p/flags/:f/archive`, `/restore`                        | archive and restore                                                                          |
| `GET/POST/DELETE /api/projects/:p/flags/:f/environments/:e/schedules[/:id]` | scheduled changes                                                                            |
| `GET/POST /api/projects/:p/flags/:f/environments/:e/rollout-plans`          | progressive rollouts; start applies the first step                                           |
| `POST .../rollout-plans/:id/pause`, `/resume`, `/cancel`                    | pause, resume (restarts the step's hold) or cancel a rollout                                 |
| `GET /api/projects/:p/flags/:f/exposures?environment=&hours=`               | per-variant counts                                                                           |
| `GET/POST/PUT/DELETE /api/projects/:p/environments/:e/segments[/:s]`        | segments (with `version`)                                                                    |
| `GET /api/projects/:p/environments/:e/ruleset`                              | the environment's ruleset, for tooling and the UI                                            |
| `GET /api/projects/:p/audit?flag=&segment=&actor=&q=&from=&to=&cursor=`     | change history with diffs, searchable, keyset-paged                                          |
| `GET /api/projects/:p/audit/:id/restore?to=before\|after`                   | what restoring an entry would change, against what is live                                   |
| `POST /api/projects/:p/audit/:id/restore`                                   | restore it, or open a change request in a protected env                                      |
| `PUT /api/projects/:p/environments/:e/change-notes`                         | require a reason and/or ticket link on every change (admin)                                  |
| `GET /sdk/v1/ruleset`                                                       | snapshot with ETag and `checksum` (server keys)                                              |
| `GET /sdk/v1/stream`                                                        | SSE: `put`, then `patch` per change, each with `checksum`                                    |
| `POST /sdk/v1/evaluate`                                                     | values for a context (client keys see client-side flags only)                                |
| `GET /sdk/v1/client-stream?key=`                                            | SSE of version numbers for browsers                                                          |
| `POST /sdk/v1/events`                                                       | exposure counts, first exposures and conversions; `429` + `Retry-After` when a queue is full |
| `GET /healthz`, `GET /readyz`, `GET /metrics`                               | liveness, readiness (checks Postgres), Prometheus                                            |

Errors look like `{"error":{"code":"version_conflict","message":"...","request_id":"...","details":{...}}}`
with stable codes: `invalid_argument` 400 (with field paths in `details`), `unauthenticated` 401,
`permission_denied` 403, `not_found` 404, `already_exists` / `version_conflict` 409,
`payload_too_large` 413, `unsupported_media_type` 415, `resource_exhausted` 429,
`unavailable` 503.

## Testing

| What         | How                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Evaluator    | A second, plainly written implementation agrees with it on 1,000 random valid rulesets and contexts. Deliberately broken evaluators (exclusion after inclusion, ignoring a disabled prerequisite, rollout ranges walked backwards, negation matching missing attributes) fail it.                                                                                                                                                                                      |
| Bucketing    | MurmurHash3 checked against published vectors and a BigInt reference on random Unicode; property tests for stickiness as percentages grow and for distribution over 100k users.                                                                                                                                                                                                                                                                                        |
| Regex engine | 5,000 random patterns compared with JavaScript's `RegExp`; catastrophic patterns on 1 KB inputs finish in microseconds.                                                                                                                                                                                                                                                                                                                                                |
| Conformance  | 6 JSON case files (every operator and reason, segments, prerequisites, pinned rollout buckets, checksums of a ruleset and four patches, canonical JSON vectors) run against the core evaluator, the Node SDK over HTTP, the server's evaluate endpoint, and the browser SDK against the real server.                                                                                                                                                                   |
| Server       | Every route against a real Postgres 17 (Testcontainers): concurrent edits get one winner, two scheduler instances apply a change once, a stream resumes with exactly the missed patches, a project exported and imported again serves rulesets with the same checksums, a change made on one instance reaches a stream on another, the listener recovers when its connection is killed, revoked keys lose their streams, and tokens and contexts never reach the logs. |
| Faults       | Two real server processes behind a TCP load balancer with 40 SDK clients evaluating through it: pooled Postgres connections killed, LISTEN sessions killed and an instance SIGKILLed, each followed at once by a kill-switch change. Every SDK serves the change within about a second, no evaluation falls back to a default, and every SDK ends on the server's checksum.                                                                                            |
| SDKs         | The Node SDK against a stub server that dies mid-stream and comes back, loses a patch or sends a bad checksum; against the real server for a 10% → 50% rollout, the kill switch and a corrupted stored patch it resyncs past; the OpenFeature provider through the OpenFeature SDK; the browser SDK in jsdom.                                                                                                                                                          |
| Admin UI     | Component tests with Testing Library; Playwright against the built server for the main journeys, a two-editor conflict, a keyboard-only run, and axe (no serious or critical WCAG 2.1 AA findings) on every page at 1440 and 390 px and in dark mode.                                                                                                                                                                                                                  |
| Whole stack  | `examples/demo.sh` against two containers of the Docker image: the shared sign-in budget, per-environment versions, checksums on both instances, an instance killed and restarted, an export imported as a copy, and an incident drill: a bad change through a change request, found by search, restored through another.                                                                                                                                              |

925 Vitest tests at 97.1% line coverage (the gate requires 90%), plus 7 Playwright tests.

## Benchmarks

On an Apple M4 Max with Node 22, local evaluation, with the context matching no rule (so
every clause is checked), takes:

| Case                                                | Time       |
| --------------------------------------------------- | ---------- |
| One flag, no rules                                  | 24 ns      |
| 5 rules × 3 clauses, 1k-member segment, 10% rollout | 0.54 µs    |
| 50 rules with regex, 2 prerequisites                | 45 µs      |
| All 200 typical flags for one browser request       | 114–147 µs |

Update latency, from the API call that makes a change to each connected SSE stream receiving
it, 20 changes per run, client threads on the same machine:

| Streams | p50     | p99     | max     |
| ------- | ------- | ------- | ------- |
| 1,000   | 15.3 ms | 23.2 ms | 24.5 ms |
| 10,000  | 53.8 ms | 78.0 ms | 81.3 ms |

Recovery, from injecting a fault to each step, with two instances behind a load balancer and
40 SDKs evaluating through it; 10 rounds per fault on a 4-vCPU Xeon with Node 22 and
PostgreSQL 17, median / p95 in ms:

| Fault                                          | First accepted write | Every SDK serves the change | Every SDK ready again |
| ---------------------------------------------- | -------------------- | --------------------------- | --------------------- |
| None (baseline)                                | 42 / 154             | 42 / 157                    | never stale           |
| Every pooled Postgres connection cut           | 52 / 151             | 103 / 165                   | never stale           |
| Both LISTEN sessions cut                       | 28 / 45              | 1,015 / 1,043               | never stale           |
| One instance SIGKILLed (41–67 connections cut) | 84 / 204             | 1,038 / 1,067               | 1,003 / 1,038         |

No evaluation fell back to a default in any round. A lost LISTEN session costs the
listener's 1 s reconnect delay, and a killed instance the SDK's 0.5–1 s jittered first
reconnect.

`pnpm bench:audit` seeds 1,000,000 audit entries and times search by flag, actor, text and
dates: every query's p95 is under 3 ms against a 50 ms budget
([`bench/results/audit.json`](bench/results/audit.json)).

`pnpm bench` and `pnpm bench:fanout` reproduce the first two tables. `pnpm bench:faults` runs
the fault suite with 10 rounds per fault and writes recovery times to
[`bench/results/faults.json`](bench/results/faults.json); a nightly CI job runs it too and
keeps the JSON as an artifact.

## Admin screens

| Flags                                                                              | Flag on a phone                                                   |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| ![Flag list with search, status chips and badges](docs/screenshots/flags-1440.png) | ![Flag editor at 390 px](docs/screenshots/flag-targeting-390.png) |

More in [docs/screenshots](docs/screenshots), all produced by the end-to-end run.

## Docs and source

[docs/DESIGN.md](docs/DESIGN.md) covers the data model, evaluation order, the bucketing
algorithm, why there is a regex engine, how streaming resumes and fans out across instances,
client-side evaluation, sessions and CSRF, scheduled changes, exposure backpressure, failure
modes, limits and what would change to scale further. The code is laid out like this:

```text
packages/core          ruleset model, validation, evaluator, bucketing, semver, regex engine, diff
packages/conformance   JSON cases every evaluator must pass, and the runner
packages/sdk-node      Node SDK and OpenFeature provider
packages/sdk-browser   browser SDK
apps/server            Fastify server: admin API, SDK endpoints, streaming hub, scheduler, exposures
apps/admin             React admin UI
e2e                    Playwright and axe tests
bench                  evaluation, fan-out, fault and audit search benchmarks
examples               demo script and a small Node app
```
