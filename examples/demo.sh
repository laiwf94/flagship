#!/usr/bin/env bash
# End to end: start the stack, create a flag through the API, and watch a Node
# app using the SDK react over SSE as the flag rolls out and is switched off.
# Needs Docker, Node 22 and pnpm. Leaves the stack running; stop it with
#   docker compose down -v
set -euo pipefail
cd "$(dirname "$0")/.."

BASE=${FLAGSHIP_URL:-http://localhost:8080}
EMAIL=admin@example.com
PASSWORD=demo-password-change-me
P=/api/projects/default
JAR=$(mktemp)
LOG=$(mktemp)
APP_PID=
cleanup() {
  [[ -n $APP_PID ]] && kill "$APP_PID" 2>/dev/null || true
  rm -f "$JAR"
}
trap cleanup EXIT

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

step "Build the SDK and start Postgres and flagship"
pnpm install --frozen-lockfile >/dev/null
pnpm --filter @flagship/core --filter @flagship/node build >/dev/null
docker compose up -d --build --wait
curl -fsS "$BASE/readyz"; echo

step "Sign in (cookie session + CSRF token)"
CSRF=$(curl -fsS -c "$JAR" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" "$BASE/api/session" |
  node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).csrfToken))')
api() {
  curl -fsS -b "$JAR" -H 'content-type: application/json' -H "x-csrf-token: $CSRF" -X "$1" "$BASE$2" ${3:+-d "$3"}
}
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)$1))"; }

step "Create the flag new-checkout (off everywhere) and a server SDK key"
if ! api GET "$P/flags/new-checkout" >/dev/null 2>&1; then
  api POST "$P/flags" '{"key":"new-checkout","name":"New checkout","type":"boolean"}' | json '.key'
fi
KEY=$(api POST "$P/environments/production/api-keys" '{"kind":"server","name":"demo app"}' | json '.secret')
echo "server key ${KEY:0:12}…"

step "Start the Node app (SDK, local evaluation, SSE)"
FLAGSHIP_SDK_KEY=$KEY FLAGSHIP_URL=$BASE node examples/node-app/app.mjs >"$LOG" 2>&1 &
APP_PID=$!

wait_for() {
  local pattern=$1 start
  start=$(date +%s)
  until grep -q -- "$pattern" "$LOG"; do
    if (($(date +%s) - start > 15)); then
      echo "timed out waiting for: $pattern"; cat "$LOG"; exit 1
    fi
    sleep 0.05
  done
  grep -- "$pattern" "$LOG" | tail -1
}

target() {
  local version
  version=$(api GET "$P/flags/new-checkout" | json '.version')
  api PUT "$P/flags/new-checkout/environments/production" \
    "{\"version\":$version,\"enabled\":true,\"offVariant\":\"off\",\"prerequisites\":[],\"rules\":[],\"fallthrough\":$1}" >/dev/null
}
rollout() { echo "{\"rollout\":{\"variants\":[{\"variant\":\"on\",\"weight\":$(($1 * 1000))},{\"variant\":\"off\",\"weight\":$(((100 - $1) * 1000))}]}}"; }

wait_for 'ready: new-checkout is on for 0/1000'

step "Roll out to 10%"
target "$(rollout 10)"
wait_for 'change: new-checkout is on for [0-9]*/1000 users (ruleset'

step "Grow the rollout to 50%: the first 10% stay on"
target "$(rollout 50)"
LINE=$(wait_for 'still on')
echo "$LINE"
echo "$LINE" | grep -Eq 'the first ([0-9]+) are still on.*' && {
  kept=$(echo "$LINE" | sed -E 's/.*; ([0-9]+) of the first ([0-9]+) are still on.*/\1 \2/')
  read -r a b <<<"$kept"
  [[ $a == "$b" ]] || { echo "stickiness broken: $kept"; exit 1; }
  echo "all $b users from the 10% step are still on"
}

step "Kill switch: turn it off for everyone"
api POST "$P/flags/new-checkout/environments/production/kill-switch" '{"enabled":false}' >/dev/null
wait_for 'change: new-checkout is on for 0/1000'

step "Audit trail"
api GET "$P/audit?flag=new-checkout&limit=5" |
  json ".entries.map(e => e.at.slice(11,19) + '  ' + e.actor + '  ' + e.action).join('\n')"

step "Done. Admin UI: $BASE (admin@example.com / $PASSWORD)"
