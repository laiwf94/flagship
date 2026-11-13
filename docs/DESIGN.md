# flagship design

A flag should get the same answer wherever it is evaluated. The server, the Node SDK and the
admin UI's preview run one evaluator from one package, and a shared set of JSON cases proves
it. Evaluation never waits on the network: server SDKs hold the ruleset in memory, so a flag
check is a function call, and when the service is down apps keep working on the last ruleset
they saw, or on their own defaults if they never saw one.

Changes have to be safe to make. Edits are versioned, validated as a whole ruleset before
they commit, previewed before they are saved, and recorded with who made them. Every input
has a size limit, and no rule can make an SDK do unbounded work, regular expressions
included.

This version records first exposures and conversions for experiments but doesn't yet compute
significance, per-user overrides beyond segments, and multi-region replication. See
[Larger deployments](#larger-deployments).

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

## How a flag is evaluated

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

## Sticky percentage rollouts

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

The tests use published MurmurHash3 vectors, a property test against a BigInt reference
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

## Storage and the write path

PostgreSQL through Kysely, with typed tables and migrations in code. Fifteen tables; the
interesting ones:

| Table                                                                               | Holds                                                                  |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `flags`                                                                             | per-project definition, variants (JSONB), metadata `version`           |
| `flag_configs`                                                                      | per-environment targeting (JSONB rules) with its own `version`         |
| `segments`                                                                          | per-environment, with `version`                                        |
| `environments`                                                                      | `ruleset_version`, bumped on every change; `required_approvals`        |
| `ruleset_changes`                                                                   | one row per version: kind, key, new value (or null), ruleset checksum  |
| `audit_log`                                                                         | actor, action, before and after JSON                                   |
| `login_attempts`                                                                    | recent sign-in attempts per email and per address, shared by instances |
| `change_requests`, `change_request_reviews`                                         | proposed targeting or segment with its base, and each review           |
| `experiment_exposures`, `conversion_events`                                         | first exposure per context and flag; raw conversions, one per SDK id   |
| `scheduled_changes`, `exposure_counts`, `sessions`, `api_keys`, `users`, `projects` |                                                                        |

Every write follows the same shape inside one transaction:

1. Lock the affected `environments` rows, **in id order**, so two writers touching
   overlapping environments can't deadlock. This also serialises writes per
   environment, which keeps ruleset versions gapless.
2. Lock the flag or segment row and compare its version (see below). Targeting edits take
   the flag row in share mode, so edits to two environments of one flag run side by side,
   while a metadata edit waits for them and they wait for it.
3. Load the environment's current ruleset, apply the change, and run the full
   `validateRuleset`. This is what catches a removed variant that a prerequisite still
   names, a deleted segment a rule still uses, or a new cycle.
4. Write, bump `ruleset_version`, read the environment's ruleset back, insert the
   `ruleset_changes` row with the entry's value and the ruleset's checksum taken from that
   read, write the audit entry, and `pg_notify`. The patch value comes from the read, not
   from the code that made the change, so a patch can never disagree with a snapshot.

Because NOTIFY is delivered at commit, listeners never hear about a change that rolled
back. `ruleset_changes` keeps the last 1,000 versions per environment
(`FLAGSHIP_CHANGE_RETENTION`).

Migrations run at start under Kysely's Postgres migrator, which takes an advisory lock;
the test starts three migrators at once on an empty database.

## Two people editing one flag

Every segment has a `version`, and so does every flag, twice over: `flags.version` covers
the metadata (name, description, variants, client side, archived) and
`flag_configs.version` covers the targeting in one environment. An edit names the version it
was based on; if that row has moved on, the server answers `409 version_conflict` with the
current version, and the UI explains that someone else saved and offers to reload. The test
fires three edits from the same version at once: exactly one wins.

Because the versions are separate, editing development never conflicts with editing
production, and renaming a flag never conflicts with editing its targeting. The tests start
edits to two environments and the metadata from one load, at once, and all of them land.
Splitting them does not lose safety. Whole-ruleset validation still runs on every write, so a
targeting draft that uses a variant someone has just removed is refused with the reason.

The targeting version a save sends is `environments.<env>.version` from `GET` on the flag;
the flag list gives it as `targetingVersion` for the listed environment. Migration
`003_flag_config_versions` set every environment's targeting version to the flag's version
at the time, so an editor who loaded a flag before the upgrade can still save.

SDKs see one `version` per flag in the ruleset: metadata version plus targeting version,
minus one. Each change bumps exactly one of the two by one, so the number SDKs see goes up
by one with each change that reaches that environment, and a new flag starts at 1.

The kill switch is the exception. It takes no version, because someone reaching for it
during an incident should not be asked to reload first, and flipping one boolean on top of
whatever else changed is safe. It still bumps that environment's targeting version, so an
editor with an older draft there gets a 409 instead of silently turning the flag back on.

## Streaming changes to SDKs

`GET /sdk/v1/stream` (server keys) speaks Server-Sent Events:

```text
retry: 2000

id: 41
event: put
data: {"environment":"production","version":41,"flags":{...},"segments":{...},"checksum":"d82f..."}

id: 42
event: patch
data: {"kind":"flag","key":"new-checkout","value":{...},"checksum":"df31..."}

: ping
```

The `id` is the ruleset version. On reconnect, the SDK (or the browser's EventSource) sends
`Last-Event-ID`; the server replays exactly the patches after it from `ruleset_changes`, or
sends a fresh `put` when some of them have been pruned or the id is from the future (a
restored database, say).

### Checksums

Versions say that an SDK has seen every change, not that it applied them right. A patch lost
in a proxy, one the SDK couldn't parse, or a bug on either side would leave it evaluating a
ruleset the server never had, with nothing to show for it. So every snapshot and every patch
carries the checksum of the whole ruleset at that version, and the SDK checks it.

The checksum is defined in `packages/core/src/checksum.ts`, with vectors in
`packages/conformance/cases/checksums.json` for SDKs in other languages:

- Each flag and segment has an entry digest: SHA-256 of `kind`, a newline, the key, a
  newline and the value's canonical JSON. Canonical JSON follows RFC 8785: no whitespace,
  object keys sorted by UTF-16 code units, numbers and strings as ECMAScript writes them.
- The ruleset's checksum is the sum of its entry digests modulo 2^256, as 64 hex digits
  (an empty ruleset is all zeros). The version and environment are left out; versions are
  checked on their own.

A sum doesn't depend on order, and replacing one entry is one subtraction and one addition,
so an SDK checks a patch in the time it takes to hash that one entry, never the whole
ruleset. It keeps each entry's digest to make that work.

The server computes a snapshot's checksum from what it read each time it builds one, so
it can't drift from the contents. A patch's checksum is computed in the write transaction
from the ruleset read back after the write. Writers to one environment are serialised by
the environment row lock, so that read always sees every earlier change. Changes recorded
before checksums existed have none, and their patches go out without one.

When a checksum doesn't match, the Node SDK keeps its last verified ruleset and doesn't
apply the patch. It drops its `Last-Event-ID` and ETag and reconnects, so the next stream
starts with a full `put`. A patch that fails validation is handled the same way, because
skipping it would leave the SDK out of step for good. `client.resyncs` counts these
recoveries and an `error` event reports each one. Reconnects after a failed check keep
backing off rather than starting again at 1 s, so a server that keeps sending something
the SDK can't verify isn't hammered. A snapshot with no checksum, from an older server, is
accepted as before.

`POST /sdk/v1/evaluate` adds `checksum`, SHA-256 of the canonical JSON of `flags`. The
browser SDK checks it with WebCrypto, so it ships no hashing code and stays
dependency-free. On a mismatch it keeps the values it had and asks again, backing off
from 1 s to 30 s. Without WebCrypto (pages served over plain http) the check is skipped.

Cost, on a 4-vCPU 2.1 GHz Xeon under Node 22 with flags of five three-clause rules each:

| Flags | Snapshot JSON | `JSON.stringify` | Checksum (node:crypto) | Checksum (core's own SHA-256) | One patch |
| ----- | ------------- | ---------------- | ---------------------- | ----------------------------- | --------- |
| 200   | 300 KiB       | 1.0 ms           | 4.6 ms                 | 9.8 ms                        | 24 µs     |
| 1,000 | 1.5 MiB       | 4.7 ms           | 22 ms                  | 47 ms                         | 22–35 µs  |
| 5,000 | 7.3 MiB       | 27 ms            | 117–124 ms             | 228–265 ms                    | 22–24 µs  |

The server pays for a full checksum when it builds a snapshot and once per write, where it
already loads the whole ruleset to validate it. SDKs pay it once per snapshot, then only
the per-patch cost. Canonical JSON uses `JSON.stringify` with a replacer that hands back
key-sorted objects, about 1.5 times faster than serialising by hand. Objects with
array-index keys such as `"10"` take the hand-written path, because JavaScript always
enumerates those keys first in numeric order.

### Fan-out across instances

Each instance keeps one dedicated connection that LISTENs on `flagship_changes`. On a
notification it reads the `ruleset_changes` rows it hasn't sent yet for that environment and
writes them to its subscribers, serialised per environment so patches leave in version
order. The rows are the source of truth, not the payloads: notifications can be coalesced,
and the catch-up read covers that. If the listener connection drops, the instance
reconnects, drops its snapshot cache and re-runs catch-up for every environment it serves;
the test kills the LISTEN backend, makes twelve changes (more than the retention of ten) and
sees the subscriber receive a fresh `put`.

### Joining without a gap

A new subscriber is registered before its snapshot is read, and events that arrive meanwhile
are held in a backlog. After the snapshot (or the replay) is written, the subscriber catches
up from the database and drains the backlog, skipping versions it has already sent. Each
subscriber tracks the highest version it has been sent, which makes delivery idempotent.

### Slow clients, limits, revocation and shutdown

A stream with more than 1 MB queued in its socket is closed rather than buffered further; it
reconnects with its last id and loses nothing. `FLAGSHIP_MAX_STREAMS` caps streams per
instance and `FLAGSHIP_MAX_STREAMS_PER_KEY` per server key, with `429` and `Retry-After`
beyond. Revoking a key sends a NOTIFY on `flagship_keys`, and every instance closes that
key's streams at once. Shutdown ends every stream so clients reconnect to another instance.

### Polling

`GET /sdk/v1/ruleset` serves the same snapshot with a strong ETag
(`"<env prefix>-<version>"`) and its `checksum`, and answers `304` when unchanged; SDKs poll it when streaming
is off or down. Snapshots are cached per environment, invalidated by the notification, with
a 30 s TTL only as a backstop for a lost notification, and loaded in a read-only
`REPEATABLE READ` transaction so flags, segments and version agree.

## Browsers get values, not rules

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

Failed sign-ins are limited per email (10 per 15 minutes, sliding) and per client address (50).
The budget lives in Postgres, in `login_attempts`, so every instance draws on the same one. Each
attempt is reserved before the password is checked, with one `INSERT ... ON CONFLICT DO UPDATE
... RETURNING` for both keys: the decision is made on the row Postgres has locked, so thirty
guesses fired at once across two instances get exactly ten password checks (the test does
that). A refused attempt is not recorded, so hammering a locked email does not extend its
lockout, and the answer is `429` with `Retry-After` set to when the oldest counted attempt leaves
the window. After the check, a failure keeps the reservation; a success clears the email's
budget and hands the address its attempt back, so an office behind one address is only limited
on wrong passwords. A row holds at most its limit of timestamps, and the scheduler loop deletes
expired rows once a minute, 1,000 at a time, oldest first.

If the limiter's query fails, sign-in fails closed with `503` and `Retry-After: 5`: no session is
issued without a counted attempt. Signed-in users are unaffected, since only sign-in uses it.

Roles are `viewer` < `editor` < `admin`, set per route and enforced in one hook. Admins can't
demote or disable themselves, so a project can't lose its last admin by accident.

## Change requests

An environment can require approvals (`PUT .../environments/:env/approvals`, admins, zero to
five). Above zero it is **protected**: targeting edits, segment edits (create, update, delete)
and new scheduled changes there are refused with `403`, and targeting and segments change only
through change requests. The kill switch still
works directly, because nobody should wait for a review in an incident, and it is audited
like any other change.

A change request proposes the whole targeting of one flag in one environment
(`POST .../flags/:flag/environments/:env/change-requests`), or a whole segment there
(`POST .../environments/:env/segments/:segment/change-requests`). It records what it started
from (`base`) and that version (`baseVersion`, which must be live when it is proposed), so
reviewers see exactly what would change. A segment request can also create a segment
(`baseVersion` 0, `base` null) or delete one (`segment: null`); a delete a flag still depends on
is refused when proposed. It is validated against the whole
ruleset when proposed, rebased and applied.

- **Reviews** are comments, approvals or requests for changes, each for the revision the
  reviewer saw. A reviewer's standing decision is their latest approval or request on the
  current revision. Authors can comment but cannot approve or reject their own request.
- **Apply** needs `max(1, required_approvals)` distinct approvers and no standing request for
  changes. It goes through the normal write path with `baseVersion` as the precondition, so a
  request whose target moved on is refused, and of two requests from one base only the first
  lands. The request row is locked first, so two applies of one request give one winner.
- **Stale detection** compares `baseVersion` with the live version. A segment deleted and
  created again starts over at version 1, so for segments the live content is compared with
  the base too. A stale request shows
  what changed live since its base and runs a three-way merge (base, proposal, live).
  Objects merge field by field; rules merge by `id` and prerequisites by `flag`, so edits to
  different rules don't conflict, and an order change on one side is kept. Segment members
  merge as sets, so each side's additions and removals all apply; a segment rule merges by
  `id`. Deleting a segment the other side edited, or two sides creating one differently, is
  a conflict on the whole `segment`. A part both sides changed differently is a conflict,
  reported with all three values.
- **Rebase** writes the merge as a new revision on the live base when there are no conflicts.
  Approvals of the old revision no longer count, so the merged result is reviewed again.
- **Close**: the author or an admin can close an open request without applying it.

Every step is in the target's audit history (`flag.change_request.open` or
`segment.change_request.open`, then `.approve`, `.request_changes`, `.apply`, `.rebase`,
`.close`), and the apply entry holds the targeting or segment before and after like any edit.

## Reasons and audit search

Every write can say why. Two request headers carry it, so no request body changes shape and a
`DELETE` can carry them too: `Flagship-Reason` (percent-encoded UTF-8, 1 to 1,000 characters
after trimming) and `Flagship-Link` (an `http` or `https` URL of at most 2,000 characters, such
as a ticket or incident). Malformed values are refused with `400` and a field path such as
`header.flagship-reason`, before anything changes. Both go on the change's audit entry.

An admin can make them mandatory per environment (`PUT .../environments/:env/change-notes`,
`{"requireReason": true, "requireLink": false}`); the setting is in the project listing and
in exports. Then targeting edits, the kill switch, segment writes and new scheduled changes
there without them are refused with `400`, naming what is missing. A change request's title
stands in for its reason, so only a required link has to come with the proposal. The request
keeps the reason and link it was proposed with, and its apply is recorded with them (the
title when no reason was given), not with whatever the person pressing Apply sent.
Project-level changes (flag names, archiving) have no environment and never require one.

`GET /api/projects/:p/audit` searches the log, newest first:

| Parameter         | Matches                                                                 |
| ----------------- | ----------------------------------------------------------------------- |
| `flag`, `segment` | one target (not both)                                                   |
| `actor`           | the exact actor name                                                    |
| `q`               | words in the action, target, actor, reason and link (web-search syntax) |
| `from`, `to`      | entry time, `from` inclusive and `to` exclusive (ISO 8601 with offset)  |
| `cursor`, `limit` | the `next` value of the previous page; 1–200 entries (50)               |

Text search uses a generated `tsvector` column with a GIN index and the `simple`
configuration, so keys and names match as typed and nothing is stemmed. Separators inside
words (`.-_/:@#?&=+~%`) become spaces before indexing, and the query is rewritten the same
way with each such word made a phrase: `INC-42` finds "inc 42" in that order, and
`kill_switch` finds `flag.kill_switch`. `"quoted phrases"`, `-word` and `or` work as in
`websearch_to_tsquery`.

Pages are keyset pages on `(created_at, id)`: the cursor is the last entry's
microsecond-precision time and id, so a deep page costs what the first does and entries with
the same timestamp are neither skipped nor repeated. The project, target and actor filters
each have a B-tree index in that order, so a date range is an index range and the first 50
matches end the scan. The response asks for one entry more than the page to tell whether
`next` is null.

## Rollback

An audit entry that changed something live is a snapshot: its `before` and `after` hold the
whole state of what it changed, and its `snapshot` column says which kind that is. `flag` is a
flag's settings (name, description, variants, client-side), `targeting` is its targeting in one
environment, and `segment` is a segment, where a missing side means the segment did not exist.
Every live write sets it: targeting edits, the kill switch, scheduled changes, change request
applies, segment writes, flag creation and settings edits, and restores themselves. Change
request openings and reviews carry a proposal rather than live state, so they are not
snapshots, nor are archiving, keys or environment settings. Migration `008_audit_snapshots`
marks earlier entries of the snapshot actions, which already stored whole states. Nothing is
stored twice: the snapshot is the entry's own `before` and `after`, so restoring costs no extra
space on the audit log.

`GET /api/projects/:p/audit/:id/restore?to=before|after` (any role) is the review: the state
it would write, the live state and version it was computed against, the diff from live to
restored, and how many approvals the environment needs. `unchanged` says the live state already
matches. `POST` with `{"to", "baseVersion", "title"?, "description"?}` (editors) restores it:

- `baseVersion` must still be live, so a restore reviewed before someone else's edit is
  refused with `409` and re-reviewed rather than silently overwriting that edit.
- In an unprotected environment it writes through the same path as an edit, under the
  environment lock, recorded as `flag.config.restore` or `segment.restore` with the reason and
  link headers the environment may require. Flag settings use `flag.settings.restore`.
- In a protected environment it opens a change request instead (`201`, `outcome: "proposed"`),
  titled after the entry unless a title is given, and described with who made the original
  change, when and why. The decision is taken under the environment lock, so turning protection
  on can't race a restore. The request is then reviewed and applied like any other, and the
  author cannot approve it.
- The restored state is validated against today's ruleset like an edit: targeting that uses a
  segment, prerequisite or variant deleted since is refused with `400` and the reason, and so is
  deleting a segment (restoring the state before it was created) that a flag still uses.
- Restoring the state before a flag was created is refused; archive the flag instead.
  Restoring what is already live is refused too, so a double click records nothing.

### Incident drill

`examples/demo.sh` ends by running the whole loop against the Docker stack, with the app on
the second instance watching the flag. Production is protected with one approval and a
required reason and ticket link, and a second user (an editor) is created.

1. **Break**: the editor proposes targeting that serves `on` to everyone. Their own approval
   gets `403` and applying it unapproved gets `409`; the admin approves, the editor applies,
   and the app serves 1000/1000.
2. **Find**: one History query, `?flag=new-checkout&q=launch&actor=<editor>&from=<start>`,
   returns the request's `open` and `apply` entries with the reason and ticket; the
   `apply` entry is the restorable one. On the demo's small log it answers in about 5 ms; the
   audit benchmark covers the same filters on a million entries.
3. **Restore**: the restore review shows the diff back to the targeting before that entry and
   that one approval is needed. The admin's restore opens a change request (`201`) that the
   admin then can't approve (`403`); the editor approves, the admin applies, and the app
   serves 0/1000 about 100 ms later on the same checksum as both instances.

The drill's History, oldest first, reads as the incident did: open, approve and apply of the
launch under its reason, then open, approve and apply of the rollback under its own. Finally
the demo lifts production's protection, and since the earlier steps edit production
directly, a run that stopped during the drill is cleaned up when the next one starts.

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

## Progressive rollouts

A rollout plan steps one serve of a flag in one environment (the default rule or one rule, by
id) from a small share to everyone: a variant to roll out, the baseline everyone else keeps,
an optional `bucketBy`, and up to 20 steps whose weights strictly grow and end at 100%. Each
step but the last has a hold of 1 minute to 30 days. A step writes
`[variant: w, baseline: 100% - w]`, variant first, so with the sticky bucketing above a
context gets the variant exactly when its bucket is below `w`, and raising `w` only adds
contexts. The last step serves the variant outright, so a finished rollout leaves the flag
plainly on. A property test checks over random step lists, salts and keys that nobody who had
the variant at one step loses it at a later one, and a server test checks the same over
3,000 contexts bucketed by `org`, with every company kept together.

Starting a plan applies its first step in the same transaction, so the response shows it
live; starting needs the flag on, and like scheduled changes it is refused in a protected
environment. `rollout_plans` keeps the step applied last and, while active, `next_at`.
The scheduler loop claims a due plan with `FOR UPDATE SKIP LOCKED`, takes the environment
lock, re-reads the flag and applies the next step through the normal write path (validation,
version bump, stream patch, audit entry by "Rollout by alice") in a savepoint, then moves
`step` and `next_at` in the same transaction. Another instance skips the claimed row, and
once it commits the row is no longer due, so each step happens once (the test races two
instances through a whole plan and counts one audit entry per step).

Before stepping, the loop checks what it is about to build on. If the flag is off the plan
pauses (`kill_switch`); turning the flag off also pauses it at once, inside the write that
turned it off, and turning it back on does not resume it, because whoever turned it off had
a reason. If the targeted serve no longer matches the step the plan applied, someone edited
it by hand: the plan pauses (`edited`) rather than overwrite the edit, and won't resume over
it. A targeted rule that was deleted, or a step that no longer validates, fails the plan with
the reason. Resuming restarts the current step's hold. Cancelling leaves the targeting where
the plan reached, and archiving the flag cancels its plans. One plan per flag and environment
can be live (active or paused), held by a partial unique index as well as the check under
the environment lock.

Lock order keeps this free of deadlocks: the scheduler and pause, resume and cancel take the
plan row, then the environment; a write that holds the environment and pauses or cancels
plans (the kill switch, archiving) skips plan rows that are locked rather than waiting, since
the holder re-reads the flag after it gets the environment. Environments are locked
`FOR NO KEY UPDATE`, which serialises writers but doesn't block the foreign key checks of
audit entries written by other transactions.

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

## Conversion events and first exposures

Experiments need two more things than counts: which variant each context saw **first**, and
what it did afterwards. Both travel on `POST /sdk/v1/events`, next to the counts, as two more
optional lists. One request carries up to 1,000 items in all.

```json
{
  "events": [{ "flag": "checkout", "variant": "b", "count": 40, "at": 1794537600000 }],
  "exposures": [{ "flag": "checkout", "variant": "b", "key": "user-17", "at": 1794537601234 }],
  "conversions": [
    {
      "id": "1b4e28ba-2fa1-11d2-883f-0016d3cca427",
      "event": "purchase",
      "key": "user-17",
      "value": 25.5,
      "at": 1794537659000
    }
  ]
}
```

**First exposures.** An SDK reports a context's exposure to a flag once, and only when a
percentage split bucketed it (reason `SPLIT`). Contexts served a fixed variant by a rule or
the kill switch aren't part of any experiment, and leaving them out is what keeps this cheap:
one row per bucketed context and flag, not one per evaluation. The SDK remembers the pairs
it has reported in a set of `maxSeenContexts` (10,000 on servers, 1,000 in browsers), oldest
forgotten first. Forgetting one only means it may be reported again, which costs one row
update.

The server keeps the **earliest** report per (environment, flag, context): pending reports
are merged in memory, and the upsert into `experiment_exposures` replaces a row only when
`(first_at, variant)` sorts before the stored one. So the result doesn't depend on which
instance or which retry reports first, and two reports at the same millisecond agree on the
smaller variant key. A context first bucketed into `off` at 10% that a later step moves to
`on` still counts for `off`, which is what an experiment needs: its conversions belong to the
variant it was assigned when it entered.

**Conversions.** `track(event, context, value?)` in the Node SDK and `track(event, value?)` in
the browser SDK (for the current user) queue a conversion with a random id, the event key, the
context key, an optional value (a price, a duration; finite, at most 10^15) and the time.
Rows go into `conversion_events` with `ON CONFLICT (environment_id, id) DO NOTHING`, and
pending conversions are keyed by id too, so a batch whose answer was lost and is sent again
is stored once. They are stored raw because attribution depends on when each context was
first exposed, which may be reported later than the conversion.

**Attribution.** `attributedConversions` joins the two tables: a conversion counts for the
variant a context was first served, if it happened at or after that exposure and inside the
window (`occurred_at >= first_at` and `< first_at + window`). Conversions before the first
exposure, outside the window, or from contexts never exposed count for no one. The result per
variant is exposed contexts, converted contexts, conversions and the sum of values. The
`conversion_events (environment_id, event_key, context_key, occurred_at)` index serves the
join.

**Backpressure** works as for counts. First exposures and conversions share one bounded
queue of `FLAGSHIP_EVENTS_QUEUE_LIMIT` pending records (a report already pending takes no
more room), flushed on the same interval. A request is checked against both queues before
anything is added, and is refused whole with `429` and `Retry-After` if either is full, so
the counts in it aren't taken without its conversions. A failed flush puts records back, and
since both writes are idempotent, a flush that failed half way is safe to repeat.
Timestamps more than a week old or five minutes ahead are dropped, as for counts.
`flagship_experiment_events_total{kind,result}` and `flagship_experiment_queue_entries`
expose both sides.

The SDKs bound their buffers at `maxEvents` first exposures plus conversions (10,000 on
servers, 1,000 in browsers) and count what they drop (`droppedEvents`); `track()` returns
false then, and for an invalid event key or value. A batch waiting to be retried keeps its
place, so newer events are the ones dropped. Requests are packed to at most 1,000 items and
about 200 KB, under the server's 256 KiB body limit even with 1,024-character context keys.
In browsers, `sendBeacon` batches are packed to 60 KB (browsers cap a beacon at about 64 KB).
`sendExposures: false` turns off counts and first exposures but not `track()`.

A client key can report exposures and conversions for any context key, as any client-side
analytics can; results should be read with that in mind for client-side flags.

## Flag lifecycle and stale flags

Every flag has a stage in each environment, computed by `lifecycleOf` in
`packages/core/src/lifecycle.ts` from its targeting, when that targeting last changed, when the
flag was created and when it was last evaluated there:

| Stage      | When                                                                                 |
| ---------- | ------------------------------------------------------------------------------------ |
| `new`      | created less than 30 days ago and not evaluated there yet                            |
| `active`   | evaluated in the last 30 days, and serving more than one variant or changed recently |
| `launched` | every context gets the same variant, and the targeting hasn't changed for 30 days    |
| `inactive` | not evaluated for 30 days (or never, for a flag older than that)                     |
| `archived` | archived in the project                                                              |

`launched` and `inactive` are stale, and carry their reasons: "serves `on` to everyone,
unchanged since 2026-10-01", "switched off since …", "not evaluated since …". One variant
for everyone means the kill switch is off, or every rule and the default rule serve the same
variant (a rollout counts only variants with a non-zero weight, so one finished at 100% is
launched) and no prerequisite can send anyone to the off variant.

**Last evaluated** comes from exposures. Each flush also upserts `flag_evaluations`
(environment, flag key, latest hour seen) with `greatest`, so a late report of an older window
never moves it back, and in key order so two instances flushing at once lock rows in the same
order. It has hour precision like the counts, so an evaluation in the hour a flag was created
counts as after its creation, and evaluations older than the flag (a key deleted and created
again) are ignored. Migration `009_flag_lifecycle` backfills it from the stored counts.

The flag list computes the stage on every read, so it is always current, and the
`GET /api/projects/:p/environments/:e/stale-flags` cleanup list classifies every unarchived flag
of the environment (at most 5,000) in memory, longest stale first. In the console each row
shows a chip for new and stale flags, with the reasons in its tooltip and for screen readers,
and **Cleanup** lists the stale ones with their reasons and last evaluation.

The **nightly lifecycle check** runs from the scheduler's housekeeping loop every hour. Each
turn claims, in transactions of 500 with `FOR UPDATE SKIP LOCKED`, the targeting rows not
checked in the last 24 hours, so every row is checked about once a day by exactly one instance.
It stores the stage and, when a flag becomes stale or stops being stale (other than by being
archived), records a `flag.lifecycle` audit entry by "Lifecycle check" with the old and new
stage and the reasons, so History answers when a flag went stale. It then publishes
`flagship_flags_lifecycle{stage}` and counts transitions in
`flagship_lifecycle_transitions_total{stage}`.

## Export and import

`GET /api/projects/:p/export` writes a whole project as one JSON document, and
`POST /api/projects/import` creates a project from one. Both are for admins. Together they back
up a project's configuration, move it between installations, and copy a project
(`?key=shop-copy&name=...`).

```text
{
  "format": "flagship.project",
  "formatVersion": 1,
  "exportedAt": "2026-11-02T09:30:00.000Z",
  "project": { "key": "shop", "name": "Shop" },
  "environments": [ { "key": "production", "name": "Production" }, ... ],
  "flags": [
    {"key":"checkout","name":...,"type":"boolean","variants":[...],"salt":"checkout",
     "clientSide":true,"archived":false,"version":2,"environments":{"production":{...,"version":5}}},
    ...
  ],
  "segments": [
    {"environment":"production","key":"beta","name":...,"included":[...],"version":3},
    ...
  ],
  "checksums": { "production": "6b55...", "staging": "8744..." }
}
```

The document holds what decides an evaluation: environments, every flag (archived ones too)
with its targeting in each environment, and segments. API keys are left out, because only
their hashes are stored and a copied key would be a second door into the same environment.
Scheduled changes, the audit log and exposure counts are history, so they are left out too.
Each flag and segment is one compact line, so a diff of two exports shows which ones changed,
and the file is a third the size of a fully indented one.

**Writing.** The export runs in one read-only `REPEATABLE READ` transaction, so the document
is one consistent snapshot even while people keep editing; the test makes a change between
the first chunk and the rest and checks it isn't in the file. Flags are read 200 at a time
with their targeting, segments 20 at a time, and each page is written before the next is
read, so a large project costs a page of memory, not a document. The project is looked up
before the first byte, so an unknown key is still a clean `404`. A client that disconnects
ends the stream, which rolls the transaction back and returns the connection.

**Checksums.** The last field is each environment's ruleset checksum, the one SDKs verify
(see [Checksums](#checksums)), built up entry by entry as the flags and segments go out. It
does two jobs. A download cut short isn't valid JSON, so it can't be imported by mistake. And
a file changed after export no longer matches. An edit made on purpose imports once
`checksums` is removed.

**Reading.** The importer checks the whole document before writing anything, and reports up
to 100 problems with paths into the document:

1. the header: `format`, and `formatVersion`, which names the versions this server reads;
2. shape and limits with the same schemas as the API, strict, so a misspelt field is an error;
3. unique environment, flag and segment keys; every flag has targeting for exactly the listed
   environments; segments belong to a listed environment;
4. each environment as a ruleset through `validateRuleset`, the check every edit passes, so
   dangling segment references, unknown variants and prerequisite cycles are refused;
   archived flags are checked on their own, so restoring one later can't fail;
5. the checksums, when present.

Then one transaction inserts the project, environments, flags, targeting and segments in
batches, with a single `project.import` audit entry. A failure part way rolls all of it back;
the test makes the last insert fail. Salts and versions are kept, so every context gets the
same variant as before, the copy's rulesets have the same checksums as the original, and an
editor holding a version from the exported file can save in the copy. Hand-written files can
leave out salts, versions, descriptions, `clientSide` and `archived`.

The import body limit is `FLAGSHIP_IMPORT_MAX_MB` (32 by default), separate from the 1 MB
limit on other admin routes. The importer holds the parsed document in memory, so that limit
is also its memory bound. A full-size project (5,000 flags of five three-clause rules in two
environments, and 100 segments of 1,000 members in each) is a 19 MB file. On a 4-vCPU
2.8 GHz Xeon under Node 22:

| Step                                        | Time      | Memory                            |
| ------------------------------------------- | --------- | --------------------------------- |
| Export (streamed, 18.8 MiB out)             | 2.0–2.2 s | 6 MiB live heap at peak, after GC |
| Validate the document (`planImport`)        | 2.4–3.4 s | the parsed document               |
| Import, validation and the inserts included | 5.3–5.7 s | the parsed document               |

## Admin UI

React and Vite, served by the same server with a strict CSP (`default-src 'self'`, no inline
script or style) and `frame-ancestors 'none'`. Choices worth knowing:

- Targeting is a draft per environment. A review dialog shows the diff (the same `diff` the
  audit log uses) and blocks saving while the draft fails `validateRuleset`, the exact check
  the server runs, so field errors appear before a round trip. Leaving with unsaved changes asks
  first.
- The preview evaluates the draft in the browser with the core evaluator over 10,000 sample
  users and any users typed in, and says how many sample users would change variant.
- In a protected environment the same review dialog opens a change request instead of saving,
  and the segment editor proposes creates, edits and deletes. The review page
  (`/change-requests/:id`) shows the diff, the same preview run over base and proposal with
  the rest of the live ruleset, the discussion by revision, and approve, request-changes,
  apply, rebase and close as the server allows them. A segment request previews each flag
  whose variants depend on it, directly or through prerequisites. The author's own request
  offers no approval, matching the server rule, and a disabled Apply says why.
- Every form that writes in an environment (the targeting review, the kill switch dialog,
  the segment editor and its delete, scheduling) has Reason and Ticket link fields, sent as
  the `Flagship-Reason` and `Flagship-Link` headers. They are marked required, and checked
  before the request, when the environment asks for them; a change request form asks only for
  the link, since its title is the reason. The Undo on the kill switch's toast resends the same
  note. Settings shows each environment's approvals and note rules, and an admin changes the
  note rules there. History searches by text, exact actor name and a range of local days (the
  last day included), with the filters in the URL so a search can be shared; older pages keep
  the same filters.
- For editors, every History entry that changed a flag or segment has a Restore action. Its
  dialog picks the state before the change (undo it) or right after it (undo what came later),
  shows the diff against what is live now, and asks for the environment's reason and link. In
  a protected environment it says how many approvals are needed, offers a title, and goes to
  the change request it opens. A conflict reloads the diff against the new live state.
- Status is a badge, filters are chips that live in the URL, on/off is a switch,
  2–4 choices are a segmented control, results are toasts (the kill switch's has Undo), errors
  sit at the field.
- Under 900 px the sidebar becomes a bottom bar; no page scrolls sideways at 390 px (checked
  by Playwright), and every page passes axe with no serious or critical WCAG 2.1 AA findings,
  in light and dark mode.

## When things fail

### On the server

| Failure                          | Effect                                                                                                     | Recovery                                                                            |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Postgres down                    | admin API and new snapshots fail with 500/503; `/readyz` 503; open streams stay open; SDKs keep evaluating | automatic when Postgres returns; pool connections that died are replaced            |
| Pooled connection terminated     | the request using it fails with 500                                                                        | the pool drops it and opens a new one; the process never exits over it              |
| Listener connection lost         | changes stop reaching this instance's streams                                                              | reconnect after 1 s, drop caches, catch up from `ruleset_changes`                   |
| Notification missed              | same, for one change                                                                                       | the next change's catch-up includes it; cache TTL bounds snapshot staleness to 30 s |
| Slow SSE client                  | its socket buffer grows                                                                                    | closed at 1 MB; it resumes from its last id                                         |
| Event queue full                 | `429` + `Retry-After`                                                                                      | SDK keeps and retries the batch                                                     |
| Sign-in limiter unreachable      | sign-in answers `503` with `Retry-After: 5` (fails closed)                                                 | automatic when the query succeeds again                                             |
| Scheduled change no longer valid | not applied                                                                                                | marked `failed` with the reason                                                     |
| Two edits at once                | one wins                                                                                                   | the other gets `409` and reloads                                                    |
| Instance killed                  | in-flight transactions roll back; exposure counts since the last flush are lost                            | SDKs reconnect elsewhere and resume                                                 |

### In the SDKs, when the service is down

| Situation                          | Node SDK                                                                                                                                             | Browser SDK                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Before the first ruleset           | every call returns the caller's default, reason `ERROR`, code `PROVIDER_NOT_READY`; `ready()` resolves `false` after its timeout                     | same                          |
| Service unreachable after start    | keeps evaluating the last ruleset; status `stale`; polls with ETags every 30 s while it reconnects the stream with jittered backoff (1 s up to 30 s) | keeps the last values         |
| Stream silent past 60 s (no ping)  | reconnects, resuming from its last id                                                                                                                | EventSource reconnects itself |
| Server sends an invalid ruleset    | ignored; the last good ruleset stays; `error` event                                                                                                  | n/a                           |
| Patch invalid or checksum mismatch | not applied; the last verified ruleset stays; `error` event; reconnects without `Last-Event-ID` for a full snapshot, with backoff                    | keeps its values, asks again  |
| Key revoked or wrong               | stops retrying, emits `error`                                                                                                                        | values stay at defaults       |

The OpenFeature provider maps these to `PROVIDER_NOT_READY`, `Stale` and `Ready` events.

## Limits

| Thing                               | Limit                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| Flags / segments per environment    | 5,000 / 1,000                                                                  |
| Variants per flag                   | 20                                                                             |
| Rules per flag, clauses per rule    | 100, 20                                                                        |
| Values per clause                   | 1,000 (each ≤ 1,024 chars)                                                     |
| Segment include / exclude lists     | 10,000 each                                                                    |
| Prerequisites per flag, chain depth | 10, 10                                                                         |
| String / JSON variant value         | 4,096 chars / 32 KB                                                            |
| Regex pattern, regex input          | 256 chars, 1,024 chars                                                         |
| Context attributes                  | 100 (strings ≤ 1,024, lists ≤ 100)                                             |
| Request body                        | 1 MB admin, 32 MB project import (configurable), 64 KB evaluate, 256 KB events |
| Events per batch                    | 1,000                                                                          |
| Streams                             | 20,000 per instance, 1,000 per server key (configurable)                       |

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

`pnpm bench:audit [--entries N] [--runs N] [--budget MS] [--out FILE]` seeds one project
with 1,000,000 audit entries over 400 days in a stock `postgres:17-alpine` (2,000 flags, 200
segments, 50 actors with a skewed share of changes, a reason on one entry in three and a link
on one in ten), then times 200 runs of `searchAudit`, the function behind the route, per query
with a 50-entry page and its diffs. It writes `bench/results/audit.json` and exits 1 if any
p95 reaches the budget (50 ms). On a 4-vCPU Xeon with Node 22 (table 728 MB, search index
38 MB), in ms:

| Query                                | p50         | p95         | p99         |
| ------------------------------------ | ----------- | ----------- | ----------- |
| newest page                          | 1.45        | 2.38        | 7.02        |
| deep page (keyset cursor at 500,000) | 1.13        | 2.51        | 4.85        |
| one flag                             | 1.11        | 2.31        | 6.11        |
| one actor (frequent / rare)          | 0.93 / 1.05 | 1.93 / 2.10 | 8.15 / 5.49 |
| text: unique ticket number           | 0.89        | 1.48        | 3.08        |
| text: common word / phrase           | 1.22 / 1.39 | 2.16 / 2.53 | 5.25 / 3.92 |
| text: no match                       | 0.65        | 0.90        | 1.00        |
| one day / 30 days a year ago         | 0.90 / 0.85 | 1.25 / 1.32 | 5.75 / 2.56 |
| flag in the last 90 days             | 0.90        | 1.42        | 3.97        |
| actor and word / word in one week    | 1.35 / 1.22 | 2.81 / 1.85 | 6.21 / 2.00 |

`pnpm bench:faults [--rounds N] [--out FILE]` runs `apps/server/test/faults` with N rounds
per fault (10) and writes a JSON report (`bench/results/faults.json` by default) when every
test passed. Schema 1 holds the commit, the machine, the configuration, every round, and per
fault the min, median, nearest-rank p95 and max of the time to the first accepted write, to
every SDK serving the change and to every SDK being ready, with totals of refused writes and
default evaluations. The report is refused unless every fault ran all its rounds. The
`nightly` workflow runs it at 03:17 UTC (or on demand with a round count), adds the summary
table to the job summary and keeps the JSON as an artifact for 90 days.

The published report, 10 rounds per fault on a 4-vCPU Xeon with Node 22 and PostgreSQL 17,
in ms from the fault (median / p95 / max):

| Fault                                   | First accepted write | Every SDK serves the change | Every SDK ready again | Refused writes |
| --------------------------------------- | -------------------- | --------------------------- | --------------------- | -------------- |
| none                                    | 42 / 154 / 154       | 42 / 157 / 157              | never stale           | 0              |
| `postgres-connections` (3–20 sessions)  | 52 / 151 / 151       | 103 / 165 / 165             | never stale           | 1              |
| `listen-sessions` (2 sessions)          | 28 / 45 / 45         | 1,015 / 1,043 / 1,043       | never stale           | 0              |
| `instance` (41–67 connections, SIGKILL) | 84 / 204 / 204       | 1,038 / 1,067 / 1,067       | 1,003 / 1,038 / 1,038 | 4              |

What the numbers come from:

- **Pooled connections.** A write that lands on a terminated connection fails with 500
  (once over ten rounds); the pool drops the connection and the retry 50 ms later gets a
  fresh one. Open streams don't hold a pooled connection, so no SDK goes stale.
- **LISTEN sessions.** Writes are unaffected, but the notification for the change is lost.
  The listener reconnects after its fixed 1 s delay and catches up from `ruleset_changes`,
  which accounts for nearly all of the 1,015 ms.
- **Instance.** A write in flight to the killed instance is lost with its connection, and
  the retry goes to the other one, since the balancer skips a backend that refuses the
  connection (four lost writes over ten rounds). Its SDKs go stale, wait the first jittered
  reconnect delay (0.5–1 s), reconnect through the balancer to the other instance and resume
  from `Last-Event-ID`, so they get exactly the missed patches rather than a snapshot.
- Across all 40 rounds no evaluation fell back to the caller's default, and every SDK ended
  on the server's checksum without a resync.

`examples/demo.sh` repeats the instance case by hand against Docker: it SIGKILLs the
container serving the app, saves the kill switch on the other and starts the container again.
The app has the change about 2–3 s after the start, most of which is the container booting
and running its migration check; it then serves the same checksum as the other instance.

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
under fastify's ajv, which we don't use for validation), undici 8.12.2 (dev only, via jsdom),
glob 14.0.3 (cancelled searches kept walking the filesystem; used by @fastify/static) and minimatch
11.0.4 (denial of service on crafted patterns; used by ESLint and Testcontainers), with the two
new packages they need, @isaacs/nonrecursive-glob-match and path-scurry.

Not dependencies, on purpose: the MurmurHash, semver parser, regex engine, SSE parser and
Prometheus exposition are each under 300 lines here, tested against references, and keep the
SDKs free of transitive code.

## Larger deployments

More instances already work: streams, the scheduler, migrations and the sign-in limiter
coordinate through Postgres, so the only requirement is a load balancer that allows long-lived
responses. `docker compose --profile multi` runs a second instance on port 8081 against the
same database, which is what the demo uses to show both sharing one sign-in budget and serving
identical checksums.

One LISTEN connection per instance is fine for hundreds of instances. For millions of streams,
put a relay tier in front that holds the client streams and subscribes once per environment,
which is how hosted flag services fan out to edge locations.

For large rulesets, patches are already per flag, and the snapshot is the expensive part.
Snapshots can be served from object storage, keyed by version, and carried by a CDN. Exposure
volume grows by one row per flag, variant, hour and environment from the hourly upserts. For
per-user analytics, send events to a log such as Kafka or Kinesis and aggregate them there.

## Further reading

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
