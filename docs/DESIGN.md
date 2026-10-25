# flagship design

## Goals

1. **Same answer everywhere.** The server, the Node SDK and the admin UI's preview run one
   evaluator from one package, and a shared set of JSON cases proves it.
2. **Evaluation never waits on the network.** Server SDKs hold the ruleset in memory; a
   flag check is a function call. When the service is down, apps keep working on the
   last ruleset they saw, or on their own defaults if they never saw one.
3. **Changes are safe to make.** Edits are versioned, validated as a whole ruleset before
   they commit, previewed before they are saved, and recorded with who made them.
4. **Bounded cost.** Every input has a size limit, and no rule can make an SDK do
   unbounded work. That includes regular expressions.

Non-goals for this version: experimentation statistics (we count exposures, we don't
compute significance), per-user overrides beyond segments, and multi-region replication.
See [Scaling out](#scaling-out).

## Data model

A **project** has **environments** (development, production, ...). A **flag** belongs to
a project and has a type (`boolean`, `string`, `number`, `json`) and two to twenty
**variants**, each a key and a value. Its targeting is per environment:

```text
enabled        kill switch: false means everyone gets offVariant, nothing else runs
offVariant     served when off or when a prerequisite isn't met
prerequisites  [{flag, variant}]: other flags that must be on and serve that variant
rules          [{id, clauses[], serve}]: first rule whose clauses all match wins
fallthrough    the default rule: one variant, or a percentage rollout
```

A **segment** is a reusable audience in one environment: an include list of context
keys, an exclude list, and rules made of attribute clauses.

What SDKs receive is a **ruleset**: one environment's flags (in the form above) and
segments, plus a version number that goes up by one with every change. The Zod schemas
in `packages/core/src/model.ts` are the single definition; the server, both SDKs and
the UI import them.

A **context** is whoever a flag is evaluated for: `{ "key": "user-42", "country": "de",
"groups": ["beta"] }`. Attributes are flat: strings, numbers, booleans, null or lists
of those.

## Evaluation order

`evaluate(ruleset, flagKey, context)` never throws. In order:

1. Unknown flag or a context without a string `key`: reason `ERROR` with a code; the
   caller uses its own default.
2. Kill switch off: `offVariant`, reason `DISABLED`.
3. Each prerequisite is evaluated recursively. It is met only if that flag is **on** and
   serves the required variant; a disabled flag whose off variant happens to match does
   not count. Unmet: `offVariant`, reason `PREREQUISITE_FAILED`.
4. Rules top to bottom; all clauses of a rule must match. First match: reason
   `TARGETING_MATCH` with the rule id.
5. The default rule: `DEFAULT` for a fixed variant, `SPLIT` for a rollout.

Reason names follow the OpenFeature specification so the provider can pass them through.

## Targeting rules

| Operator                             | Matches when                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `equals`, `in`                       | the attribute equals the value / one of the values, same type (no coercion)                                                          |
| `contains`, `startsWith`, `endsWith` | string tests                                                                                                                         |
| `matches`                            | the pattern finds a match (see [Regex safety](#regex-safety))                                                                        |
| `lt`, `lte`, `gt`, `gte`             | number comparisons                                                                                                                   |
| `semverEq`, `semverLt`, `semverGt`   | Semantic Versioning 2.0.0 precedence, pre-releases included; `2` and `2.1` are read as `2.0.0` and `2.1.0`, a leading `v` is ignored |
| `inSegment`                          | the context is in any of the listed segments                                                                                         |

A list attribute matches if any element does. A **missing or null attribute never
matches, even when the clause is negated**: "country is not US" says nothing about
someone whose country we don't know, and treating them as a match would quietly widen
a rollout to every context that forgot to send the attribute. Type mismatches (a
number operator on a string) are no match, not an error.

Segment membership checks the exclude list first, then the include list, then the
segment's rules. Exclusion wins over everything because it is the explicit "never this
person" an operator reaches for. Include and exclude lists are indexed into sets the first
time a segment object is evaluated, so a 10,000-member segment costs a hash lookup.

## Bucketing

A percentage rollout must give each context the same variant on every server and SDK,
and growing it from 10% to 50% must not move anyone out of the 10%.

```text
bucket = murmur3_x86_32(utf8(salt + ":" + value)) mod 100,000
```

`value` is the context key, or the attribute named by `bucketBy` (for example `org`, so
everyone in a company gets the same variant). A missing `bucketBy` attribute falls back
to the key rather than to a fixed bucket. A fixed bucket would put every context without
the attribute into the first variant.

Variants take cumulative ranges in the order they are declared: with `[on: p, off: 100% - p]`
a context is on exactly when `bucket < p`, so raising `p` only adds contexts. The flag's
`salt` defaults to its key, which makes two flags at 50% split users independently
(checked: the overlap of two 50% flags over 100k users is 25% within one point).

MurmurHash3 is the hash Unleash uses for the same job and is simple to reproduce in any
language; it needs no async API, so the browser preview runs it synchronously. The modulo
has a bias of 67,296 buckets getting one extra hash value in about 42,950, a relative
skew of 2.3e-5, which no rollout can observe. Weights are integers out of 100,000, so
the smallest step is 0.001%.

Tests: published MurmurHash3 vectors, a property test against a BigInt reference
implementation on arbitrary Unicode (lone surrogates included, since UTF-8 is encoded by
hand to match `TextEncoder`), stickiness for random keys and percentages, and a
distribution test over 100k keys. Pinned bucket outcomes in the conformance suite make
any other implementation prove it hashes the same way.

## Regex safety

`matches` patterns are typed into the UI and then run in every SDK on every evaluation.
JavaScript's `RegExp` backtracks, so `(a+)+$` on thirty `a`s and a `!` takes minutes.
Recognising dangerous patterns is a losing game (`(a|a)*`, `\w*\w*\w*` and friends), so
the core has its own small engine instead, following Russ Cox's description of RE2: the
pattern compiles to a Thompson NFA and a Pike VM runs it, keeping a set of states per
input position. Cost is O(input × program), with both bounded:

| Bound                    | Value                                         |
| ------------------------ | --------------------------------------------- |
| Pattern length           | 256 characters                                |
| Repeat counts in `{m,n}` | ≤ 100                                         |
| Compiled program         | ≤ 4,000 instructions                          |
| Input length             | 1,024 UTF-16 units; longer inputs never match |

Supported: literals, `.`, `^`, `$`, `|`, groups, classes and ranges, `\d \w \s` and their
negations, `* + ? {m,n}`. Backreferences, lookaround, word boundaries and flags are
rejected with a position, at validation time, so the UI shows the problem at the field.
Matching works on code points, like `RegExp` with the `u` flag. A property test runs 5,000
random patterns from the supported subset against `RegExp` and requires identical results;
the catastrophic patterns above run against a 1 KB input in well under a millisecond.

The cost shows in the benchmark: fifty regex clauses are most of the 45 µs "large" case.
That is fine for a worst case, and it can never turn into minutes.

## Prerequisites

Prerequisites form a graph across flags. Validation rejects cycles (reporting the cycle,
for example `a -> b -> c -> a`) and chains longer than ten flags. The evaluator also keeps
the chain it is on and refuses to recurse into a flag already on it or past ten levels,
returning `PREREQUISITE_CYCLE`, so a ruleset that somehow skipped validation still
cannot loop.

## Storage

PostgreSQL through Kysely, with typed tables and migrations in code. Twelve tables; the
interesting ones:

| Table                                                                               | Holds                                                                  |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `flags`                                                                             | per-project definition, variants (JSONB), `version`                    |
| `flag_configs`                                                                      | per-environment targeting (JSONB rules), keyed by environment and flag |
| `segments`                                                                          | per-environment, with `version`                                        |
| `environments`                                                                      | `ruleset_version`, bumped on every change                              |
| `ruleset_changes`                                                                   | one row per version: kind, key, new value (or null for a delete)       |
| `audit_log`                                                                         | actor, action, before and after JSON                                   |
| `scheduled_changes`, `exposure_counts`, `sessions`, `api_keys`, `users`, `projects` |                                                                        |

Every write follows the same shape inside one transaction:

1. Lock the affected `environments` rows, **in id order**, so two writers touching
   overlapping environments can't deadlock. This also serialises writes per
   environment, which keeps ruleset versions gapless.
2. Lock the flag or segment row and compare its version (see below).
3. Load the environment's current ruleset, apply the change, and run the full
   `validateRuleset`. This is what catches a removed variant that a prerequisite still
   names, a deleted segment a rule still uses, or a new cycle.
4. Write, bump `ruleset_version`, insert the `ruleset_changes` row, write the audit entry,
   and `pg_notify`.

Because NOTIFY is delivered at commit, listeners never hear about a change that rolled
back. `ruleset_changes` keeps the last 1,000 versions per environment
(`FLAGSHIP_CHANGE_RETENTION`).

Migrations run at start under Kysely's Postgres migrator, which takes an advisory lock;
the test starts three migrators at once on an empty database.

## Optimistic concurrency

Every flag and segment has a `version`. An edit names the version it was based on; if the
row has moved on, the server answers `409 version_conflict` with the current version, and
the UI explains that someone else saved and offers to reload. The test fires three edits
from the same version at once: exactly one wins.

One version per flag covers its metadata and every environment's targeting. That gives a
false conflict when two people edit different environments of the same flag at the same
moment. We accepted that: it is rare, and the fix (reload) is cheap. The cost of a missed
conflict is a silent overwrite.

The **kill switch** is the exception. It takes no version, because someone reaching for it
during an incident should not be asked to reload first, and flipping one boolean on top of
whatever else changed is safe. It still bumps the version, so an editor with an older draft
gets a 409 instead of silently turning the flag back on.

## Streaming

`GET /sdk/v1/stream` (server keys) speaks Server-Sent Events:

```text
retry: 2000

id: 41
event: put
data: {"environment":"production","version":41,"flags":{...},"segments":{...}}

id: 42
event: patch
data: {"kind":"flag","key":"new-checkout","value":{...}}

: ping
```

The `id` is the ruleset version. On reconnect, the SDK (or the browser's EventSource) sends
`Last-Event-ID`; the server replays exactly the patches after it from `ruleset_changes`, or
sends a fresh `put` when some of them have been pruned or the id is from the future (a
restored database, say).

**Fan-out across instances.** Each instance keeps one dedicated connection that LISTENs on
`flagship_changes`. On a notification it reads the `ruleset_changes` rows it hasn't sent yet
for that environment and writes them to its subscribers, serialised per environment so
patches leave in version order. The rows are the source of truth, not the payloads:
notifications can be coalesced, and the catch-up read covers that. If the listener
connection drops, the instance reconnects, drops its snapshot cache and re-runs catch-up for
every environment it serves; the test kills the LISTEN backend, makes twelve changes (more
than the retention of ten) and sees the subscriber receive a fresh `put`.

**Joining without a gap.** A new subscriber is registered before its snapshot is read, and
events that arrive meanwhile are held in a backlog. After the snapshot (or the replay) is
written, the subscriber catches up from the database and drains the backlog, skipping
versions it has already sent. Each subscriber tracks the highest version it has been sent,
which makes delivery idempotent.

**Slow clients.** A stream with more than 1 MB queued in its socket is closed rather than
buffered further; it reconnects with its last id and loses nothing. **Limits:**
`FLAGSHIP_MAX_STREAMS` per instance and `FLAGSHIP_MAX_STREAMS_PER_KEY` per server key, with
`429` and `Retry-After` beyond. **Revocation:** revoking a key sends a NOTIFY on
`flagship_keys`; every instance closes that key's streams at once. **Shutdown** ends every
stream so clients reconnect to another instance.

`GET /sdk/v1/ruleset` serves the same snapshot with a strong ETag
(`"<env prefix>-<version>"`) and answers `304` when unchanged; SDKs poll it when streaming
is off or down. Snapshots are cached per environment, invalidated by the notification, with
a 30 s TTL only as a backstop for a lost notification, and loaded in a read-only
`REPEATABLE READ` transaction so flags, segments and version agree.

## Client-side evaluation

Browser and mobile apps can't be trusted with rules: a rule like
`email endsWith @acquisition-target.com` is itself a secret, and segment include lists are
lists of real users. So client keys never get the ruleset. `POST /sdk/v1/evaluate` takes the
context **in the body** (never in a URL, so it stays out of access logs and caches),
evaluates every flag marked `clientSide`, and returns value, variant and reason per flag:
no rule ids, no segment names, nothing about other users. The test seeds a hidden segment and
asserts none of its members, its name, the rule ids or the other flags appear in the answer.

The client stream (`/sdk/v1/client-stream?key=fsc_...`) carries only version numbers. The key
is in the query string because EventSource cannot send headers; that is acceptable because a
client key is public by design and can only do what the page could do anyway. On a newer
version the browser SDK re-posts its context. `identify()` bumps a sequence number, and
answers for an older sequence are dropped, so a slow response for the previous user can't
overwrite the current one.

## API keys

Server keys are `fss_` and client keys `fsc_`, followed by 256 random bits in base64url. Only
the SHA-256 is stored, with a 12-character prefix for display. A salted slow hash would buy
nothing here: the secret already has full entropy, and looking up by hash means comparison
time doesn't depend on the secret. The full key is shown once, at creation. `last_used_at` is
written at most once a minute per key and instance.

## Sessions and CSRF

Admin users sign in with email and password, hashed with scrypt (N=2^15, r=8, p=1, 16-byte
salt). That is half the OWASP minimum work factor for scrypt at p=1. We chose it to keep
sign-in under about 100 ms on small instances, and it is the first knob to turn if the
threat model changes. The hash string carries its own parameters, so raising them later
needs no migration. An unknown email still runs a dummy verification, so timing doesn't
reveal which emails exist. The error is the same in both cases.

A session is a random 256-bit token in an `httpOnly`, `SameSite=Lax` cookie (`Secure` behind
HTTPS, or always when `FLAGSHIP_COOKIE_SECURE=true`); the database stores its SHA-256. Sessions
end after 12 hours idle (sliding, written at most once a minute) or 7 days regardless. Changing
a password, a role change and disabling a user end the user's other sessions.

CSRF has two layers. Every state-changing request needs the session's synchronizer token in
`X-CSRF-Token`, compared in constant time, which a cross-site form cannot set. And any request
whose `Origin` is not ours (or an allowed origin) is refused before anything else, which also
covers sign-in, the one route without a session. Sign-in only accepts JSON, so a cross-site
form post fails with 415.

Failed sign-ins are limited per email (10 per 15 minutes) and per IP (50). The limiter is in
memory, so N instances give N times the budget: still small against scrypt per guess. A shared
store is listed under scaling out.

Roles are `viewer` < `editor` < `admin`, set per route and enforced in one hook. Admins can't
demote or disable themselves, so a project can't lose its last admin by accident.

## Scheduled changes

A scheduled change sets `enabled`, the default rule or the rule list of one flag in one
environment at a future time (within a year). It is validated when created, to catch typos,
and again when it runs, because the flag may have changed in between.

Each instance runs a worker loop. It claims one due row at a time with
`FOR UPDATE SKIP LOCKED` in its own transaction, so any number of instances can run it and a
change is applied exactly once (the test races two workers on one row). The apply goes
through the same path as a manual edit, with its validation, version bump, stream patch and
audit entry (actor "Scheduled by alice"), inside a savepoint. If the change no longer validates
(say its segment was deleted), the savepoint is rolled back and the row is marked `failed`
with the reason. A failure isn't retried forever, and the UI shows it. Archiving a flag
cancels its pending changes.

## Exposure events

Exposures (which variant was served) let the UI show a per-variant count. SDKs aggregate in
memory, counting per flag and variant, and send counts, not events: a busy service evaluating
a flag a million times a minute sends one row per variant per flush.

The server folds batches into a bounded in-memory map keyed by environment, flag, variant and
hour, and writes it every two seconds as multi-row upserts
(`count = exposure_counts.count + excluded.count`). The bound is on distinct rows, which is
what costs memory. A batch that would cross it is refused **whole** with `429` and
`Retry-After`: the SDK keeps it and retries, so nothing it was told was accepted is lost, and
nothing is half-applied. A failed flush puts its rows back. Timestamps older than a week or
more than five minutes in the future are dropped and counted.

The SDKs bound their side too: at most `maxExposureKeys` distinct pairs between flushes, then
new pairs are dropped and counted (`droppedExposures`). They back off exponentially on errors
and honour `Retry-After`. The browser SDK also flushes with `sendBeacon` when the page is
hidden, posting `text/plain` (no CORS preflight) with the client key in the query string.

Counts are per instance until flushed, so a crash loses at most one flush interval. For a
feature count that is the right trade against a write per request.

## When the service is down

| Situation                                | Node SDK                                                                                                                                             | Browser SDK                   |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Before the first ruleset                 | every call returns the caller's default, reason `ERROR`, code `PROVIDER_NOT_READY`; `ready()` resolves `false` after its timeout                     | same                          |
| Service unreachable after start          | keeps evaluating the last ruleset; status `stale`; polls with ETags every 30 s while it reconnects the stream with jittered backoff (1 s up to 30 s) | keeps the last values         |
| Stream silent past 60 s (no ping)        | reconnects, resuming from its last id                                                                                                                | EventSource reconnects itself |
| Server sends an invalid ruleset or patch | ignored; the last good ruleset stays; `error` event                                                                                                  | n/a                           |
| Key revoked or wrong                     | stops retrying, emits `error`                                                                                                                        | values stay at defaults       |

The OpenFeature provider maps these to `PROVIDER_NOT_READY`, `Stale` and `Ready` events.

## Admin UI

React and Vite, served by the same server with a strict CSP (`default-src 'self'`, no inline
script or style) and `frame-ancestors 'none'`. Choices worth knowing:

- Targeting is a draft per environment. A review dialog shows the diff (the same `diff` the
  audit log uses) and blocks saving while the draft fails `validateRuleset`, the exact check
  the server runs, so field errors appear before a round trip. Leaving with unsaved changes asks
  first.
- The preview evaluates the draft in the browser with the core evaluator over 10,000 sample
  users and any users typed in, and says how many sample users would change variant.
- Status is a badge, filters are chips that live in the URL, on/off is a switch,
  2–4 choices are a segmented control, results are toasts (the kill switch's has Undo), errors
  sit at the field.
- Under 900 px the sidebar becomes a bottom bar; no page scrolls sideways at 390 px (checked
  by Playwright), and every page passes axe with no serious or critical WCAG 2.1 AA findings,
  in light and dark mode.

## Failure modes

| Failure                          | Effect                                                                                                     | Recovery                                                                            |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Postgres down                    | admin API and new snapshots fail with 500/503; `/readyz` 503; open streams stay open; SDKs keep evaluating | automatic when Postgres returns; idle pool connections that died are replaced       |
| Listener connection lost         | changes stop reaching this instance's streams                                                              | reconnect after 1 s, drop caches, catch up from `ruleset_changes`                   |
| Notification missed              | same, for one change                                                                                       | the next change's catch-up includes it; cache TTL bounds snapshot staleness to 30 s |
| Slow SSE client                  | its socket buffer grows                                                                                    | closed at 1 MB; it resumes from its last id                                         |
| Event queue full                 | `429` + `Retry-After`                                                                                      | SDK keeps and retries the batch                                                     |
| Scheduled change no longer valid | not applied                                                                                                | marked `failed` with the reason                                                     |
| Two edits at once                | one wins                                                                                                   | the other gets `409` and reloads                                                    |
| Instance killed                  | in-flight transactions roll back; exposure counts since the last flush are lost                            | SDKs reconnect elsewhere and resume                                                 |

## Limits

| Thing                               | Limit                                                    |
| ----------------------------------- | -------------------------------------------------------- |
| Flags / segments per environment    | 5,000 / 1,000                                            |
| Variants per flag                   | 20                                                       |
| Rules per flag, clauses per rule    | 100, 20                                                  |
| Values per clause                   | 1,000 (each ≤ 1,024 chars)                               |
| Segment include / exclude lists     | 10,000 each                                              |
| Prerequisites per flag, chain depth | 10, 10                                                   |
| String / JSON variant value         | 4,096 chars / 32 KB                                      |
| Regex pattern, regex input          | 256 chars, 1,024 chars                                   |
| Context attributes                  | 100 (strings ≤ 1,024, lists ≤ 100)                       |
| Request body                        | 1 MB admin, 64 KB evaluate, 256 KB events                |
| Events per batch                    | 1,000                                                    |
| Streams                             | 20,000 per instance, 1,000 per server key (configurable) |

## Security

- Inputs are validated at every boundary with Zod: strict objects (unknown fields refused),
  bounded strings, lists and numbers. Flag and segment keys can't start with `_`, and all
  record lookups use own-property checks, so `__proto__` and `constructor` can't reach the
  prototype.
- Errors leave as `{"error":{"code","message","request_id"}}`. Unexpected errors become a
  generic 500 and their details go to the log only.
- Logs are JSON with request ids. Headers aren't logged, `authorization`, `cookie` and
  `x-csrf-token` are redacted as a second guard, and `key=` in URLs is masked. Tests check that
  session tokens, passwords and contexts don't appear in log output.
- `/metrics` answers loopback only unless `FLAGSHIP_METRICS_TOKEN` is set.
- The Docker image runs as nonroot on distroless Node; compose runs it read-only with no
  capabilities.

## Benchmarks

Apple M4 Max, Node 22.

`pnpm bench` evaluates in one process with the context matching no rule (the worst path:
every clause is checked):

| Case                                                       | Time per evaluation |
| ---------------------------------------------------------- | ------------------- |
| One flag, no rules                                         | 24 ns               |
| 5 rules × 3 clauses, 1k-member segment, 10% rollout        | 0.54 µs             |
| 50 rules with regex, 2 prerequisites                       | 45 µs               |
| `evaluateAll`, 200 typical flags (one client-side request) | 114–147 µs          |

`pnpm bench:fanout` starts Postgres and the built server, connects N streams from four worker
threads, makes 20 kill-switch changes and measures from sending the API call (so the write
transaction is included) to each stream receiving the patch:

| Streams | p50     | p99     | max     |
| ------- | ------- | ------- | ------- |
| 1,000   | 15.3 ms | 23.2 ms | 24.5 ms |
| 10,000  | 53.8 ms | 78.0 ms | 81.3 ms |

Client and server share one machine, so these numbers include the client threads' own parsing.

## Dependencies

Each is mainstream, maintained, and pinned exactly. pnpm refuses any version (direct or
transitive) published less than 14 days ago (`minimumReleaseAge`). The exceptions are
security fixes taken on purpose and named in `pnpm-workspace.yaml`:

| Package                                                                                                              | Why                                                                       |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| zod                                                                                                                  | one schema language for server validation, SDK checks and UI field errors |
| fastify, @fastify/cookie, @fastify/static                                                                            | HTTP server; static serving handles path traversal so we don't            |
| pino                                                                                                                 | JSON logging with redaction (Fastify's logger)                            |
| kysely, pg                                                                                                           | typed SQL without an ORM; the queries stay visible                        |
| react, react-dom, react-router                                                                                       | admin UI                                                                  |
| @openfeature/server-sdk (optional peer)                                                                              | the vendor-neutral flag API the provider implements                       |
| dev: vitest, fast-check, Testcontainers, Playwright, axe, Testing Library, jsdom, Vite, ESLint, Prettier, TypeScript | the gate                                                                  |

Security exceptions to the 14-day rule: zod 4.6.6 (memory exhaustion validating oversized
collections), fastify 5.12.7 (header validation bypass), fast-uri 3.1.9 / 4.2.3 (URI parsing,
under fastify's ajv, which we don't use for validation), undici 8.12.2 (dev only, via jsdom).

Not dependencies, on purpose: the MurmurHash, semver parser, regex engine, SSE parser and
Prometheus exposition are each under 300 lines here, tested against references, and keep the
SDKs free of transitive code.

## Scaling out

- **More instances.** Already supported: streams, the scheduler and migrations coordinate
  through Postgres. Put instances behind a load balancer that allows long-lived responses.
- **Sign-in limiter** state should move to a shared store (Postgres or Redis) so the budget
  doesn't multiply with instances.
- **Millions of streams.** One LISTEN connection per instance is fine for hundreds of
  instances. Beyond that, put a relay tier in front that holds client streams and subscribes
  once per environment, which is how hosted flag services fan out to edge locations.
- **Large rulesets.** Patches are per flag already; the snapshot is the expensive part. Serve
  snapshots from object storage keyed by version and let the CDN carry them.
- **Exposure volume.** Hourly upserts are one row per flag/variant/hour/environment. For
  per-user analytics, send events to a log (Kafka, Kinesis) and aggregate there instead.
- **Version per environment.** Splitting the flag version into one per environment would remove
  the cross-environment false conflicts noted above, at the cost of a more complex API.

## References

- OpenFeature, "Specification" — https://openfeature.dev/specification/
- OpenFeature, "Providers" — https://openfeature.dev/docs/reference/concepts/provider
- Unleash, "Stickiness" — https://docs.getunleash.io/reference/stickiness
- LaunchDarkly, "Percentage rollouts" — https://launchdarkly.com/docs/home/releases/percentage-rollouts
- LaunchDarkly, "Client-side, server-side, and edge SDKs" — https://launchdarkly.com/docs/sdk/concepts/client-side-server-side
- Pete Hodgson, "Feature Toggles (aka Feature Flags)" — https://martinfowler.com/articles/feature-toggles.html
- Russ Cox, "Regular Expression Matching Can Be Simple And Fast" — https://swtch.com/~rsc/regexp/regexp1.html
- Russ Cox, "Regular Expression Matching: the Virtual Machine Approach" — https://swtch.com/~rsc/regexp/regexp2.html
- Austin Appleby, "SMHasher / MurmurHash3" — https://github.com/aappleby/smhasher
- WHATWG, "HTML Standard: Server-sent events" — https://html.spec.whatwg.org/multipage/server-sent-events.html
- Tom Preston-Werner, "Semantic Versioning 2.0.0" — https://semver.org
- PostgreSQL, "NOTIFY" and "SELECT ... FOR UPDATE SKIP LOCKED" — https://www.postgresql.org/docs/current/sql-notify.html, https://www.postgresql.org/docs/current/sql-select.html
- OWASP, "Password Storage Cheat Sheet" and "Cross-Site Request Forgery Prevention Cheat Sheet" — https://cheatsheetseries.owasp.org/
