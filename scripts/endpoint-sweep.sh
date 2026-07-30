#!/usr/bin/env bash
# Hits every runtime endpoint against a live server and reports what each returns.
# A 5xx, or a 404 on a route that should exist, is a failure.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
PORT="${PORT:-7833}"
ADMIN="admin-$RANDOM"
BASE="http://127.0.0.1:$PORT"

ok=0
bad=0

cleanup() {
  [[ -n "${PID:-}" ]] && kill "$PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

probe() { # probe <method> <path> <expected-codes> [body] [token]
  local method="$1" path="$2" expected="$3" body="${4:-}" token="${5:-$ADMIN}"
  local code
  if [[ -n "$body" ]]; then
    code=$(curl -s -o /dev/null -w '%{http_code}' -X "$method" "$BASE$path" \
      -H "authorization: Bearer $token" -H 'content-type: application/json' -d "$body")
  else
    code=$(curl -s -o /dev/null -w '%{http_code}' -X "$method" "$BASE$path" \
      -H "authorization: Bearer $token")
  fi
  if [[ " $expected " == *" $code "* ]]; then
    printf '  %-4s %-38s %s\n' "$method" "$path" "$code"
    ok=$((ok + 1))
  else
    printf '  %-4s %-38s %s  <-- expected %s\n' "$method" "$path" "$code" "$expected"
    bad=$((bad + 1))
  fi
}

(cd "$ROOT" && npm run build >/dev/null 2>&1)

printf 'version: 1\npolicies:\n  - name: prod-delete\n    match:\n      actions: ["database.delete"]\n      environments: ["production"]\n    decision:\n      effect: block\n' > "$WORK/policies.yaml"

node "$ROOT/packages/cli/dist/index.js" serve \
  --policies "$WORK/policies.yaml" --data-dir "$WORK/data" --port "$PORT" \
  --admin-token "$ADMIN" --enforcement "default=enforce" > "$WORK/server.log" 2>&1 &
PID=$!
for _ in $(seq 1 40); do curl -sf "$BASE/healthz" >/dev/null 2>&1 && break; sleep 0.5; done

REGISTERED=$(curl -s -X POST "$BASE/v1/agents" -H "authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' -d '{"name":"probe","kind":"claude-code"}')
AGENT=$(echo "$REGISTERED" | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
AGENT_ID=$(echo "$REGISTERED" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['agent']['id'])")

# An approval to resolve, and a decision and plan to read back.
curl -s -o /dev/null -X POST "$BASE/v1/actions/check" -H "authorization: Bearer $AGENT" \
  -H 'content-type: application/json' \
  -d '{"action":"database.delete","environment":"production","sessionId":"s1"}'
DECISION=$(curl -s -X POST "$BASE/v1/memory/decisions" -H "authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' \
  -d '{"title":"t","statement":"s","owner":"o","actions":["x.*"]}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")
PLAN=$(curl -s -X POST "$BASE/v1/plans" -H "authorization: Bearer $AGENT" \
  -H 'content-type: application/json' \
  -d '{"sessionId":"s9","steps":[{"name":"read","allows":["repository.read"]}]}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")
VERSION=$(curl -s "$BASE/v1/policies" -H "authorization: Bearer $ADMIN" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['version'])")

echo
echo "== health and metrics"
probe GET  /healthz                              "200"
probe GET  /v1/metrics                           "200"

echo
echo "== decisions"
probe POST /v1/actions/check                     "200" '{"action":"repository.read"}'
probe POST /v1/actions/outcome                   "202" '{"decisionEventId":"e","action":"repository.read","status":"succeeded","rolledBack":false}' "$AGENT"
probe POST /v1/authorize                         "200" '{"action":"repository.read"}' "$AGENT"
probe POST /v1/decision                          "200" '{"action":"repository.read"}'
probe POST /v1/evaluate-risk                     "200" '{"action":"repository.read"}'

echo
echo "== agents"
probe POST /v1/agents                            "200 201" '{"name":"another","kind":"cursor"}'
probe GET  /v1/agents                            "200"
probe GET  "/v1/agents/$AGENT_ID"                "200"
probe POST "/v1/agents/$AGENT_ID/status"         "200" '{"status":"active"}'

echo
echo "== policies"
probe GET  /v1/policies                          "200"
probe POST /v1/policies/validate                 "200" '{"version":1,"policies":[]}'
probe PUT  /v1/policies                          "200" '{"version":1,"policies":[{"name":"r","match":{"actions":["x.y"]},"decision":{"effect":"block"}}]}'
probe GET  /v1/policies/history                  "200"
probe POST "/v1/policies/rollback/$VERSION"      "200 404"
probe POST /v1/policies/reload                   "200"

echo
echo "== plans"
probe POST /v1/plans                             "201 409" '{"sessionId":"s2","steps":[{"name":"a","allows":["x.y"]}]}' "$AGENT"
probe GET  "/v1/plans/$PLAN"                     "200" "" "$AGENT"
probe POST "/v1/plans/$PLAN/advance"             "200" "" "$AGENT"
probe POST "/v1/plans/$PLAN/close"               "200" "" "$AGENT"

echo
echo "== approvals"
probe GET  /v1/approvals                         "200"
probe GET  /v1/approvals/none                    "404"
probe POST /v1/approvals/none                    "404" '{"approved":true,"resolvedBy":"lead"}'
probe POST /v1/approvals/none/override           "404" '{"overriddenBy":"lead","reason":"break glass"}'

echo
echo "== audit"
probe GET  "/v1/audit?limit=5"                   "200"
probe GET  /v1/audit/verify                      "200"
probe GET  /v1/audit/export.csv                  "200"
probe GET  /v1/reports/compliance                "200"

echo
echo "== decision memory"
probe POST /v1/memory/decisions                  "200 201" '{"title":"t2","statement":"s2","owner":"o","actions":["z.*"]}'
probe GET  /v1/memory/decisions                  "200"
probe GET  "/v1/memory/decisions/search?q=t"     "200"
probe GET  /v1/memory/digest                     "200"
probe GET  /v1/memory/health                     "200"
probe POST /v1/memory/search                     "200" '{"query":"t"}'
if [[ -n "$DECISION" ]]; then
  probe POST "/v1/memory/decisions/$DECISION/status" "200" '{"status":"active"}'
  probe DELETE "/v1/memory/decisions/$DECISION"      "200 204"
fi

echo
echo "== proxy and integrations"
probe POST /v1/proxy/openai/v1/chat/completions   "400 401 403" '{"model":"gpt-4"}'
probe POST /v1/proxy/nope/v1/x                    "404" '{"model":"gpt-4"}'
probe POST /v1/integrations/slack/interactions    "400 401 403 404"

echo
echo "== credential rotation (last: it invalidates the token above)"
probe POST "/v1/agents/$AGENT_ID/rotate"         "200 201"
RETIRED=$(curl -s -X POST "$BASE/v1/actions/check" -H "authorization: Bearer $AGENT" \
  -H 'content-type: application/json' -d '{"action":"repository.read"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['effect'])")
if [[ "$RETIRED" == "block" ]]; then
  printf '  %-4s %-38s %s\n' "POST" "/v1/actions/check (retired token)" "block"
  ok=$((ok + 1))
else
  printf '  %-4s %-38s %s  <-- expected block\n' "POST" "/v1/actions/check (retired token)" "$RETIRED"
  bad=$((bad + 1))
fi

echo
printf '== %d answered as expected, %d unexpected\n' "$ok" "$bad"
[[ "$bad" -eq 0 ]]
