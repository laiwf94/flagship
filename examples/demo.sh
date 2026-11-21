#!/usr/bin/env bash
# End to end against the Docker stack: two flagship instances on one Postgres,
# a flag created and rolled out through instance A, and a Node app using the
# SDK on instance B that follows every change over SSE. On the way it checks
# that the instances share one sign-in budget, that development and production
# edits from one load don't conflict, that the app, A and B agree on the
# ruleset checksum, that the app recovers when B is killed, and that a project
# survives export and import with the same checksums. It ends with an incident
# drill on a protected production: a reviewed change breaks the rollout, History
# search finds it, and a restore puts it back through a second change request.
# Last, two seeded experiments go through the SDK on B and are read on A: one
# with a known +50% effect, found with exact counts, and one that loses one in
# five treatment exposures, whose results the sample ratio check hides.
# Then a webhook to a receiver on this machine that verifies every signature
# with the SDK, refuses a forged request, and recognises a replay; and a
# guarded rollout whose new checkout fails ten times as often, so its error
# rate guard rolls the plan back while the receiver hears about it.
# Needs Docker, Node 22 and pnpm. Leaves the stack running; stop it with
#   docker compose --profile multi down -v
set -euo pipefail
cd "$(dirname "$0")/.."
export COMPOSE_PROFILES=multi

A=${FLAGSHIP_URL:-http://localhost:8080}
B=${FLAGSHIP_URL_B:-http://localhost:8081}
EMAIL=admin@example.com
PASSWORD=demo-password-change-me
P=/api/projects/default
WORK=$(mktemp -d)
JAR=$WORK/cookies
LOG=$WORK/app.log
RLOG=$WORK/receiver.log
CLOG=$WORK/checkout.log
APP_PID=
RECEIVER_PID=
CHECKOUT_PID=
cleanup() {
  for pid in $APP_PID $RECEIVER_PID $CHECKOUT_PID; do kill "$pid" 2>/dev/null || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() {
  echo "FAILED: $*"
  for f in "$LOG" "$RLOG" "$CLOG"; do [[ -s $f ]] && { echo "--- $(basename "$f")"; cat "$f"; }; done
  exit 1
}
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)$1))"; }
ms() { node -e 'console.log(Math.round(performance.timeOrigin + performance.now()))'; }

step "Build the SDK and start Postgres and two flagship instances"
pnpm install --frozen-lockfile >/dev/null
pnpm --filter @flagship/core --filter @flagship/node build >/dev/null
docker compose up -d --build --wait
echo "A $A/readyz $(curl -fsS "$A/readyz")"
echo "B $B/readyz $(curl -fsS "$B/readyz")"

step "Sign in on A (cookie session + CSRF token)"
CSRF=$(curl -fsS -c "$JAR" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" "$A/api/session" | json '.csrfToken')
# api METHOD PATH [BODY]: an admin call on instance A; fails on any error status.
api() {
  curl -fsS -b "$JAR" -H 'content-type: application/json' -H "x-csrf-token: $CSRF" -X "$1" "$A$2" ${3:+-d "$3"}
}
# status METHOD PATH [BODY]: the same call, printing only the HTTP status.
status() {
  curl -sS -o /dev/null -w '%{http_code}' -b "$JAR" -H 'content-type: application/json' \
    -H "x-csrf-token: $CSRF" -X "$1" "$A$2" ${3:+-d "$3"}
}

# A run that stopped during the incident drill leaves production protected;
# the steps before the drill edit it directly, so lift that first.
if api GET /api/projects | json ".projects.find(p => p.key === 'default').environments
    .some(e => e.key === 'production' && (e.requiredApprovals > 0 || e.requireReason || e.requireLink))" |
  grep -q true; then
  api PUT "$P/environments/production/approvals" '{"requiredApprovals":0}' >/dev/null
  api PUT "$P/environments/production/change-notes" '{"requireReason":false,"requireLink":false}' >/dev/null
  echo "production was left protected by an earlier run; protection lifted"
fi

step "Sign-in budget: ten wrong passwords split across A and B lock the email on both"
GUESS="guess-$RANDOM$RANDOM@example.com"
attempt() {
  curl -sS -o /dev/null -w '%{http_code}' -H 'content-type: application/json' \
    -d "{\"email\":\"$GUESS\",\"password\":\"wrong-password-$RANDOM\"}" "$1/api/session"
}
codes=""
for i in $(seq 1 10); do
  if ((i % 2)); then codes+="A:$(attempt "$A") "; else codes+="B:$(attempt "$B") "; fi
done
echo "$codes"
[[ $codes != *429* ]] || fail "locked before ten attempts: $codes"
blockedA=$(attempt "$A")
blockedB=$(attempt "$B")
echo "11th attempt: A:$blockedA B:$blockedB"
[[ $blockedA == 429 && $blockedB == 429 ]] || fail "expected 429 from both instances"
# Forget the demo's guesses so a re-run (or your own sign-in from this machine)
# isn't held back by the shared per-address budget.
docker compose exec -T postgres psql -qAt -U flagship -c \
  "DELETE FROM login_attempts WHERE (scope = 'email' AND key = '$GUESS') OR scope = 'ip'" >/dev/null

step "Create the flag new-checkout (off everywhere) and a server SDK key"
if ! api GET "$P/flags/new-checkout" >/dev/null 2>&1; then
  api POST "$P/flags" '{"key":"new-checkout","name":"New checkout","type":"boolean"}' | json '.key'
fi
KEY=$(api POST "$P/environments/production/api-keys" '{"kind":"server","name":"demo app"}' | json '.secret')
echo "server key ${KEY:0:12}…"

step "Start the Node app on instance B (SDK, local evaluation, SSE)"
FLAGSHIP_SDK_KEY=$KEY FLAGSHIP_URL=$B node examples/node-app/app.mjs >"$LOG" 2>&1 &
APP_PID=$!

# mark: later waits only look at app output printed from here on.
FROM=0
mark() { FROM=$(wc -l <"$LOG"); }
since() { tail -n +"$((FROM + 1))" "$LOG"; }
# wait_for PATTERN [SECONDS]: wait for the app to print a matching line after
# the last mark, then print it.
wait_for() {
  local pattern=$1 limit=${2:-15} start
  start=$(date +%s)
  until since | grep -q -- "$pattern"; do
    (($(date +%s) - start > limit)) && fail "timed out after ${limit}s waiting for: $pattern"
    sleep 0.05
  done
  since | grep -- "$pattern" | tail -1
}
# app_checksum: the checksum on the app's last ready or change line.
app_checksum() { grep -E '^\[app\] (ready|change):' "$LOG" | tail -1 | sed -E 's/.*checksum ([0-9a-f]{64}).*/\1/'; }

rollout() { echo "{\"rollout\":{\"variants\":[{\"variant\":\"on\",\"weight\":$(($1 * 1000))},{\"variant\":\"off\",\"weight\":$(((100 - $1) * 1000))}]}}"; }
# targeting VERSION FALLTHROUGH: a targeting body that serves FALLTHROUGH to everyone.
targeting() { echo "{\"version\":$1,\"enabled\":true,\"offVariant\":\"off\",\"prerequisites\":[],\"rules\":[],\"fallthrough\":$2}"; }
# target ENV VERSION FALLTHROUGH: replace the targeting of new-checkout in ENV.
target() { api PUT "$P/flags/new-checkout/environments/$1" "$(targeting "$2" "$3")" >/dev/null; }
envVersion() { api GET "$P/flags/new-checkout" | json ".environments.$1.version"; }

wait_for 'ready: new-checkout is on for 0/1000'

step "Roll out to 10% in production (written on A, received on B)"
mark
target production "$(envVersion production)" "$(rollout 10)"
wait_for 'change: new-checkout is on for [0-9]*/1000 users (ruleset'

step "Edit development and production from one load: no conflict"
FLAG=$(api GET "$P/flags/new-checkout")
DEV=$(echo "$FLAG" | json '.environments.development.version')
PROD=$(echo "$FLAG" | json '.environments.production.version')
echo "loaded once: development v$DEV, production v$PROD"
target development "$DEV" '{"variant":"on"}'
echo "development: on for everyone (saved with v$DEV)"
target production "$PROD" "$(rollout 50)"
echo "production: grow the rollout to 50% (saved with v$PROD from the same load)"
stale=$(status PUT "$P/flags/new-checkout/environments/production" "$(targeting "$PROD" '{"variant":"off"}')")
echo "production again with the stale v$PROD: $stale"
[[ $stale == 409 ]] || fail "expected 409 for a stale production edit, got $stale"

step "The first 10% stay on at 50%"
LINE=$(wait_for 'still on')
echo "$LINE"
kept=$(echo "$LINE" | sed -E 's/.*; ([0-9]+) of the first ([0-9]+) are still on.*/\1 \2/')
read -r a b <<<"$kept"
[[ $a == "$b" ]] || fail "stickiness broken: $kept"
echo "all $b users from the 10% step are still on"

step "Checksums: the app, A and B hold the same ruleset"
APP=$(app_checksum)
SUM_A=$(curl -fsS -H "authorization: Bearer $KEY" "$A/sdk/v1/ruleset" | json '.checksum')
SUM_B=$(curl -fsS -H "authorization: Bearer $KEY" "$B/sdk/v1/ruleset" | json '.checksum')
printf 'app %s\nA   %s\nB   %s\n' "$APP" "$SUM_A" "$SUM_B"
[[ -n $APP && $APP == "$SUM_A" && $APP == "$SUM_B" ]] || fail "checksums differ"

step "Kill instance B, switch the flag off on A, start B again"
mark
docker compose kill -s SIGKILL flagship-b >/dev/null
wait_for 'status stale'
mark
api POST "$P/flags/new-checkout/environments/production/kill-switch" '{"enabled":false}' >/dev/null
echo "kill switch saved on A while the app's instance is down"
T0=$(ms)
docker compose start flagship-b >/dev/null
wait_for 'change: new-checkout is on for 0/1000' 60
echo "the app had the change $(($(ms) - T0)) ms after B was started"
wait_for 'status ready' 5
SUM_A=$(curl -fsS -H "authorization: Bearer $KEY" "$A/sdk/v1/ruleset" | json '.checksum')
[[ $(app_checksum) == "$SUM_A" ]] || fail "the app's checksum differs from A's after recovery"
echo "checksum after recovery matches A: ${SUM_A:0:16}…"

step "Audit trail"
api GET "$P/audit?flag=new-checkout&limit=6" |
  json ".entries.map(e => e.at.slice(11,19) + '  ' + e.actor + '  ' + e.action).join('\n')"

step "Export the project, import it as a copy, and compare checksums"
api GET "$P/export" >"$WORK/default.flagship.json"
node -e '
const doc = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
const size = require("node:fs").statSync(process.argv[1]).size;
console.log(`export: ${doc.format} v${doc.formatVersion}, ${size} bytes, ${doc.environments.length} environments, ${doc.flags.length} flags, ${doc.segments.length} segments`);
' "$WORK/default.flagship.json"
COPY="default-copy-$(date +%H%M%S)"
curl -fsS -b "$JAR" -H 'content-type: application/json' -H "x-csrf-token: $CSRF" \
  --data-binary "@$WORK/default.flagship.json" "$A/api/projects/import?key=$COPY&name=Copy%20of%20default" |
  json ".project.key" | sed 's/$/ imported/'
api GET "/api/projects/$COPY/export" >"$WORK/copy.flagship.json"
node -e '
const [a, b] = process.argv.slice(1).map((f) => JSON.parse(require("node:fs").readFileSync(f, "utf8")));
for (const env of Object.keys(a.checksums)) console.log(`${env.padEnd(12)} ${a.checksums[env]}  ${a.checksums[env] === b.checksums[env] ? "=" : "≠"}  ${b.checksums[env]}`);
const same = JSON.stringify(a.checksums) === JSON.stringify(b.checksums);
console.log(same ? "the copy serves identical rulesets" : "checksums differ");
process.exit(same ? 0 : 1);
' "$WORK/default.flagship.json" "$WORK/copy.flagship.json" || fail "the imported copy differs"

step "Incident drill: protect production (one approval, a reason and a ticket link)"
REVIEWER=riley@example.com
REVIEWER_NAME="Riley Reviewer"
REVIEWER_PASSWORD=reviewer-password-change-me
code=$(status POST /api/users \
  "{\"email\":\"$REVIEWER\",\"name\":\"$REVIEWER_NAME\",\"role\":\"editor\",\"password\":\"$REVIEWER_PASSWORD\"}")
[[ $code == 201 || $code == 409 ]] || fail "creating the reviewer gave $code"
echo "reviewer $REVIEWER_NAME ($REVIEWER, editor)"
RJAR=$WORK/reviewer-cookies
RCSRF=$(curl -fsS -c "$RJAR" -H 'content-type: application/json' \
  -d "{\"email\":\"$REVIEWER\",\"password\":\"$REVIEWER_PASSWORD\"}" "$A/api/session" | json '.csrfToken')
TICKET=https://tickets.example.com/INC-2041
# call_as WHO METHOD PATH [BODY]: a call as admin (the default user) or reviewer on A,
# with the drill's reason in $REASON and its ticket link; prints the body and
# the status on the last line.
call_as() {
  local jar=$JAR csrf=$CSRF
  [[ $1 == reviewer ]] && { jar=$RJAR; csrf=$RCSRF; }
  curl -sS -w '\n%{http_code}' -b "$jar" -H 'content-type: application/json' -H "x-csrf-token: $csrf" \
    -H "flagship-reason: $(node -e 'console.log(encodeURIComponent(process.argv[1]))' "$REASON")" \
    -H "flagship-link: $TICKET" -X "$2" "$A$3" ${4:+-d "$4"}
}
# want CODE RESPONSE: the response's status must be CODE; prints its body.
want() {
  local code=${2##*$'\n'} body=${2%$'\n'*}
  [[ $code == "$1" ]] || fail "expected $1, got $code: $body"
  echo "$body"
}
api PUT "$P/environments/production/approvals" '{"requiredApprovals":1}' >/dev/null
api PUT "$P/environments/production/change-notes" '{"requireReason":true,"requireLink":true}' >/dev/null
REASON="direct edit during the drill"
code=$(call_as admin PUT "$P/flags/new-checkout/environments/production" \
  "$(targeting "$(envVersion production)" '{"variant":"on"}')" | tail -1)
echo "a direct targeting edit in production now gets $code"
[[ $code == 403 ]] || fail "expected 403 for a direct edit to protected production, got $code"
DRILL_FROM=$(node -e 'console.log(new Date(Date.now() - 1000).toISOString())')

step "Break it: a reviewed change request turns new-checkout on for everyone"
mark
REASON="launch new checkout to all users"
CR=$(want 201 "$(call_as reviewer POST "$P/flags/new-checkout/environments/production/change-requests" \
  "{\"baseVersion\":$(envVersion production),\"title\":\"Launch new checkout\",\"enabled\":true,\"offVariant\":\"off\",\"prerequisites\":[],\"rules\":[],\"fallthrough\":{\"variant\":\"on\"}}")")
CR_ID=$(echo "$CR" | json '.id')
echo "$REVIEWER_NAME proposed change request ${CR_ID:0:8}…: $(echo "$CR" | json '.diff.length') difference(s)"
own=$(call_as reviewer POST "$P/change-requests/$CR_ID/reviews" '{"revision":1,"decision":"approve"}' | tail -1)
echo "the author approving their own request: $own"
[[ $own == 403 ]] || fail "expected 403 for a self-approval, got $own"
early=$(call_as reviewer POST "$P/change-requests/$CR_ID/apply" '{"revision":1}' | tail -1)
echo "applying it without an approval: $early"
[[ $early == 409 ]] || fail "expected 409 for an unapproved apply, got $early"
want 201 "$(call_as admin POST "$P/change-requests/$CR_ID/reviews" '{"revision":1,"decision":"approve","body":"ship it"}')" >/dev/null
echo "admin approved it"
want 200 "$(call_as reviewer POST "$P/change-requests/$CR_ID/apply" '{"revision":1}')" | json '.status' | sed 's/^/change request /'
wait_for 'change: new-checkout is on for 1000/1000'
echo "every user is on the new checkout, and checkout errors start coming in"

step "Find it: History search by text, actor and time"
QUERY="$P/audit?flag=new-checkout&q=launch&actor=$(node -e 'console.log(encodeURIComponent(process.argv[1]))' "$REVIEWER_NAME")&from=$(node -e 'console.log(encodeURIComponent(process.argv[1]))' "$DRILL_FROM")"
curl -fsS -o "$WORK/search.json" -w 'search answered in %{time_total}s\n' -b "$JAR" "$A$QUERY"
json ".entries.map(e => e.id + '  ' + e.at.slice(11,19) + '  ' + e.action + '  \"' + e.reason + '\"  ' + e.link).join('\n')" <"$WORK/search.json"
ENTRY=$(json ".entries.find(e => e.action === 'flag.change_request.apply' && e.restorable)?.id ?? ''" <"$WORK/search.json")
[[ -n $ENTRY ]] || fail "the search did not find the applied change"
echo "the change that broke it is History entry $ENTRY"

step "Restore it through a change request"
PLAN=$(api GET "$P/audit/$ENTRY/restore?to=before")
echo "$PLAN" | json ".diff.map(d => 'review: ' + d.path + ' ' + JSON.stringify(d.before) + ' -> ' + JSON.stringify(d.after)).join('\n')"
echo "restoring needs $(echo "$PLAN" | json '.requiredApprovals') approval(s)"
BASE=$(echo "$PLAN" | json '.baseVersion')
mark
REASON="roll back the checkout launch"
RESTORE=$(want 201 "$(call_as admin POST "$P/audit/$ENTRY/restore" "{\"to\":\"before\",\"baseVersion\":$BASE}")")
[[ $(echo "$RESTORE" | json '.outcome') == proposed ]] || fail "the restore did not open a change request"
RC_ID=$(echo "$RESTORE" | json '.changeRequest.id')
echo "restore opened change request ${RC_ID:0:8}…: $(echo "$RESTORE" | json '.changeRequest.title')"
own=$(call_as admin POST "$P/change-requests/$RC_ID/reviews" '{"revision":1,"decision":"approve"}' | tail -1)
echo "admin approving their own restore: $own"
[[ $own == 403 ]] || fail "expected 403 for a self-approval, got $own"
want 201 "$(call_as reviewer POST "$P/change-requests/$RC_ID/reviews" '{"revision":1,"decision":"approve","body":"confirmed against INC-2041"}')" >/dev/null
echo "$REVIEWER_NAME approved it"
T0=$(ms)
want 200 "$(call_as admin POST "$P/change-requests/$RC_ID/apply" '{"revision":1}')" | json '.status' | sed 's/^/change request /'
wait_for 'change: new-checkout is on for 0/1000'
echo "the app served the restored targeting $(($(ms) - T0)) ms after the apply"
SUM_A=$(curl -fsS -H "authorization: Bearer $KEY" "$A/sdk/v1/ruleset" | json '.checksum')
SUM_B=$(curl -fsS -H "authorization: Bearer $KEY" "$B/sdk/v1/ruleset" | json '.checksum')
[[ $(app_checksum) == "$SUM_A" && $SUM_A == "$SUM_B" ]] || fail "checksums differ after the restore"
echo "the app, A and B agree on checksum ${SUM_A:0:16}…"
api GET "$P/audit?flag=new-checkout&from=$(node -e 'console.log(encodeURIComponent(process.argv[1]))' "$DRILL_FROM")&limit=20" |
  json ".entries.reverse().map(e => e.at.slice(11,19) + '  ' + e.actor.padEnd(15) + '  ' + e.action.padEnd(31) + '  ' + (e.reason ?? '')).join('\n')"

step "Lift production's protection again"
api PUT "$P/environments/production/approvals" '{"requiredApprovals":0}' >/dev/null
api PUT "$P/environments/production/change-notes" '{"requireReason":false,"requireLink":false}' >/dev/null
echo "production takes direct edits again"

step "Experiments: two 50/50 flags in production, one with a known effect, one with a known mismatch"
RUN=$(date +%H%M%S)
EFFECT_FLAG="checkout-cta-$RUN"
SRM_FLAG="checkout-page-$RUN"
for flag in "$EFFECT_FLAG" "$SRM_FLAG"; do
  api POST "$P/flags" "{\"key\":\"$flag\",\"name\":\"Experiment $flag\",\"type\":\"boolean\"}" >/dev/null
  version=$(api GET "$P/flags/$flag" | json '.environments.production.version')
  api PUT "$P/flags/$flag/environments/production" "$(targeting "$version" "$(rollout 50)")" >/dev/null
  api POST "$P/experiments" "{\"key\":\"$flag\",\"name\":\"Does $flag sell more?\",\"flag\":\"$flag\",\"environment\":\"production\",\"control\":\"off\",\"metrics\":[{\"event\":\"purchase\",\"kind\":\"conversion\"},{\"event\":\"purchase\",\"kind\":\"value\"}]}" |
    json ".key + ' running on ' + JSON.parse(s).allocation.variants.map(v => v.variant + ' ' + v.weight / 1000 + '%').join(' / ')"
done

step "4,000 shoppers and 4,000 visitors through the SDK on B: exposures and purchases"
FLAGSHIP_SDK_KEY=$KEY FLAGSHIP_URL=$B node examples/node-app/experiment.mjs \
  simulate "$EFFECT_FLAG" "$SRM_FLAG" "$WORK/expected.json" || fail "the SDK could not send the events"

step "Results on A once the hourly rollup has counted every event"
# rolled_up FLAG: whether the results for FLAG's experiment count every
# exposure and purchase the SDK sent.
rolled_up() {
  api GET "$P/experiments/$1/results?showMismatched=true" >"$WORK/$1.poll.json"
  node -e '
const [want, got] = process.argv.slice(1).map((f) => JSON.parse(require("node:fs").readFileSync(f, "utf8")));
const arms = Object.values(want.expected[got.experiment.flag]);
const sum = (f) => arms.reduce((n, a) => n + a[f], 0);
const rate = got.metrics?.find((m) => m.kind === "conversion");
const bought = rate ? rate.variants.reduce((n, v) => n + v.converted, 0) : -1;
process.exit(got.exposed === sum("exposed") && bought === sum("converted") ? 0 : 1);
' "$WORK/expected.json" "$WORK/$1.poll.json"
}
start=$(date +%s)
until rolled_up "$EFFECT_FLAG" && rolled_up "$SRM_FLAG"; do
  (($(date +%s) - start > 90)) && fail "the results did not reach the counts the SDK sent within 90s"
  sleep 1
done
echo "rolled up after $(($(date +%s) - start))s"
api GET "$P/experiments/$EFFECT_FLAG/results" >"$WORK/effect.json"
api GET "$P/experiments/$SRM_FLAG/results" >"$WORK/srm.json"
api GET "$P/experiments/$SRM_FLAG/results?showMismatched=true" >"$WORK/srm-shown.json"
node examples/node-app/experiment.mjs check \
  "$WORK/expected.json" "$WORK/effect.json" "$WORK/srm.json" "$WORK/srm-shown.json" ||
  fail "the experiment results are wrong"
for flag in "$EFFECT_FLAG" "$SRM_FLAG"; do api POST "$P/experiments/$flag/stop" '{}' >/dev/null; done
echo "both experiments stopped; their results stay at $P/experiments/<key>/results"

step "Webhooks: a receiver on this machine, sent every production flag change"
RECEIVER_PORT=${FLAGSHIP_RECEIVER_PORT:-9090}
RECEIVER=http://localhost:$RECEIVER_PORT/flagship
# An earlier run's webhook would sign with a secret this run's receiver
# doesn't have; remove it first.
for id in $(api GET "$P/webhooks" | json ".webhooks.filter(w => w.name === 'demo receiver').map(w => w.id).join(' ')"); do
  curl -fsS -o /dev/null -b "$JAR" -H "x-csrf-token: $CSRF" -X DELETE "$A$P/webhooks/$id"
  echo "removed webhook $id from an earlier run"
done
HOOK=$(api POST "$P/webhooks" \
  "{\"name\":\"demo receiver\",\"url\":\"http://host.docker.internal:$RECEIVER_PORT/flagship\",\"environment\":\"production\",\"events\":[\"flag.*\"]}")
HOOK_ID=$(echo "$HOOK" | json '.id')
SECRET=$(echo "$HOOK" | json '.secret')
echo "webhook $HOOK_ID for flag.* in production, secret ${SECRET:0:10}… (shown once)"
[[ $(api GET "$P/webhooks/$HOOK_ID" | json '.secret === undefined') == true ]] || fail "the secret is shown again"
FLAGSHIP_WEBHOOK_SECRET=$SECRET RECEIVER_PORT=$RECEIVER_PORT node examples/node-app/receiver.mjs >"$RLOG" 2>&1 &
RECEIVER_PID=$!
# wait_in FILE PATTERN [SECONDS]: wait for a line matching PATTERN in FILE, then print it.
wait_in() {
  local file=$1 pattern=$2 limit=${3:-30} start
  start=$(date +%s)
  until grep -q -- "$pattern" "$file" 2>/dev/null; do
    (($(date +%s) - start > limit)) && fail "timed out after ${limit}s waiting for: $pattern"
    sleep 0.1
  done
  grep -- "$pattern" "$file" | tail -1
}
wait_in "$RLOG" 'listening on'

step "A guarded rollout: checkout errors on the new path, ten times as often"
GUARD_FLAG="checkout-v2-$RUN"
api POST "$P/flags" "{\"key\":\"$GUARD_FLAG\",\"name\":\"Checkout v2 ($RUN)\",\"type\":\"boolean\"}" >/dev/null
T0=$(ms)
api POST "$P/flags/$GUARD_FLAG/environments/production/kill-switch" '{"enabled":true}' >/dev/null
wait_in "$RLOG" "flag.kill_switch $GUARD_FLAG"
echo "the receiver verified the change $(($(ms) - T0)) ms after it was saved"
GUARDED=$(api POST "$P/flags/$GUARD_FLAG/environments/production/rollout-plans" '{
  "target": "fallthrough", "variant": "on", "baseline": "off",
  "steps": [{"weight": 20000, "holdMinutes": 60}, {"weight": 50000, "holdMinutes": 60}, {"weight": 100000}],
  "guards": [{"event": "checkout-error", "kind": "conversion", "worse": "higher", "threshold": 0.25,
              "minContexts": 100, "action": "rollback"}]
}')
PLAN_ID=$(echo "$GUARDED" | json '.id')
echo "plan ${PLAN_ID:0:8}… on step 1 of 3 ($(echo "$GUARDED" | json '.weight / 1000')% on);" \
  "rolls back if checkout-error is confidently 25% above off"
wait_in "$RLOG" "flag.rollout.start $GUARD_FLAG"

step "Forged and replayed requests at the receiver"
FORGED='{"id":"evt_1","type":"flag.kill_switch","target":{"type":"flag","key":"new-checkout"}}'
code=$(curl -sS -o /dev/null -w '%{http_code}' -H 'content-type: application/json' \
  -H "flagship-signature: t=$(date +%s),v1=$(printf '0%.0s' $(seq 1 64))" -d "$FORGED" "$RECEIVER")
echo "a request with a made-up signature: $code"
[[ $code == 401 ]] || fail "the receiver accepted a forged request ($code)"
code=$(curl -sS -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -d "$FORGED" "$RECEIVER")
echo "a request without a signature: $code"
[[ $code == 401 ]] || fail "the receiver accepted an unsigned request ($code)"
grep '\[receiver\] rejected' "$RLOG"
DELIVERY=$(api GET "$P/webhooks/$HOOK_ID/deliveries?event=flag.kill_switch" |
  json ".deliveries.find(d => d.status === 'succeeded')?.id ?? ''")
[[ -n $DELIVERY ]] || fail "the delivery log has no succeeded kill switch delivery"
api GET "$P/webhooks/$HOOK_ID/deliveries/$DELIVERY" |
  json ".attemptLog.map(a => 'delivery log: attempt ' + a.attempt + ' answered ' + a.status + ' in ' + a.durationMs + ' ms').join('\\n')"
REPLAY=$(api POST "$P/webhooks/$HOOK_ID/deliveries/$DELIVERY/replay" '{}')
echo "replayed as delivery $(echo "$REPLAY" | json '.id') of the same $(echo "$REPLAY" | json '.eventId')"
wait_in "$RLOG" 'duplicate .* flag.kill_switch'

step "The checkout app sends 3,000 checkouts through the SDK on B"
FLAGSHIP_SDK_KEY=$KEY FLAGSHIP_URL=$B node examples/node-app/checkout.mjs "$GUARD_FLAG" 3000 >"$CLOG" 2>&1 &
CHECKOUT_PID=$!
wait_in "$CLOG" 'checkouts sent' 60
grep -q 'FAILED' "$CLOG" && fail "the checkout app failed"

step "The guard reads the rollup and rolls the plan back"
start=$(date +%s)
until [[ $(api GET "$P/flags/$GUARD_FLAG/environments/production/rollout-plans" |
  json ".plans.find(p => p.id === '$PLAN_ID').status") == rolled_back ]]; do
  (($(date +%s) - start > 90)) && fail "the guard did not roll the plan back within 90s: $(
    api GET "$P/flags/$GUARD_FLAG/environments/production/rollout-plans/$PLAN_ID/guards")"
  sleep 1
done
echo "rolled back $(($(date +%s) - start))s after the checkouts were sent"
api GET "$P/flags/$GUARD_FLAG/environments/production/rollout-plans" | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const plan = JSON.parse(s).plans.find((p) => p.id === process.argv[1]);
  const b = plan.guardBreach;
  const pct = (x) => (x * 100).toFixed(1) + "%";
  console.log(`breach at step ${b.step + 1} (${b.weight / 1000}% on), ${b.confidence * 100}% intervals, action ${b.action}, rolled back ${b.rolledBack}`);
  for (const r of b.readings) {
    console.log(`  ${r.guard.event}: on ${pct(r.variant.mean)} of ${r.variant.exposed}, off ${pct(r.baseline.mean)} of ${r.baseline.exposed}`);
    console.log(`  lift +${pct(r.lift)} [${pct(r.liftInterval.lower)}, ${pct(r.liftInterval.upper)}], p ${r.pValue.toExponential(1)}`);
    if (!(r.liftInterval.lower > r.guard.threshold)) process.exit(1);
  }
  if (!b.rolledBack) process.exit(1);
});
' "$PLAN_ID" || fail "the breach readings are not past the threshold"
wait_in "$CLOG" "change: $GUARD_FLAG is on for 0/3000"
echo "the checkout app serves everyone the old checkout again"
SUM_A=$(curl -fsS -H "authorization: Bearer $KEY" "$A/sdk/v1/ruleset" | json '.checksum')
SUM_B=$(curl -fsS -H "authorization: Bearer $KEY" "$B/sdk/v1/ruleset" | json '.checksum')
[[ $SUM_A == "$SUM_B" ]] || fail "A and B serve different rulesets after the rollback"
api GET "$P/audit?flag=$GUARD_FLAG&limit=10" |
  json ".entries.reverse().map(e => e.at.slice(11,19) + '  ' + e.action.padEnd(22) + '  ' + e.actor).join('\n')"
wait_in "$RLOG" "flag.rollout.guard $GUARD_FLAG"
wait_in "$RLOG" "flag.rollout.rollback $GUARD_FLAG"
NEXT=$(api POST "$P/flags/$GUARD_FLAG/environments/production/rollout-plans" \
  '{"target":"fallthrough","variant":"on","baseline":"off","steps":[{"weight":10000,"holdMinutes":60},{"weight":100000}]}' |
  json '.id') || fail "the rolled-back plan still holds the flag"
api POST "$P/flags/$GUARD_FLAG/environments/production/rollout-plans/$NEXT/cancel" '{}' >/dev/null
echo "the flag is free again: a new plan started and was cancelled"

step "Done. Admin UI: $A or $B (admin@example.com / $PASSWORD)"
