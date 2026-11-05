#!/usr/bin/env bash
# End to end against the Docker stack: two flagship instances on one Postgres,
# a flag created and rolled out through instance A, and a Node app using the
# SDK on instance B that follows every change over SSE. On the way it checks
# that the instances share one sign-in budget, that development and production
# edits from one load don't conflict, that the app, A and B agree on the
# ruleset checksum, that the app recovers when B is killed, and that a project
# survives export and import with the same checksums.
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
APP_PID=
cleanup() {
  [[ -n $APP_PID ]] && kill "$APP_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { echo "FAILED: $*"; [[ -s $LOG ]] && { echo "--- app log"; cat "$LOG"; }; exit 1; }
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

step "Done. Admin UI: $A or $B (admin@example.com / $PASSWORD)"
