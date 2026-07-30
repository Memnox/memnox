#!/usr/bin/env bash
# Multi-step flows, not single endpoints. Each section drives a sequence and
# asserts the state it should have produced — an endpoint answering 200 in
# isolation says nothing about whether the flow behind it works.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
PORT="${PORT:-7844}"
ADMIN="flow-admin-$RANDOM"
BASE="http://127.0.0.1:$PORT"

ok=0
bad=0

cleanup() {
  [[ -n "${PID:-}" ]] && kill "$PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

check() { # check <description> <actual> <expected>
  if [[ "$2" == "$3" ]]; then
    printf '  ok   %s\n' "$1"; ok=$((ok + 1))
  else
    printf '  FAIL %s\n       expected %s, got %s\n' "$1" "$3" "$2"; bad=$((bad + 1))
  fi
}

jqf() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }

agent_post() { # agent_post <path> [body]
  if [[ -n "${2:-}" ]]; then
    curl -s -X POST "$BASE$1" -H "authorization: Bearer $AGENT" \
      -H 'content-type: application/json' -d "$2"
  else
    curl -s -X POST "$BASE$1" -H "authorization: Bearer $AGENT"
  fi
}
admin_send() { # admin_send <method> <path> [body]
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -s -X "$method" "$BASE$path" -H "authorization: Bearer $ADMIN" \
      -H 'content-type: application/json' -d "$body"
  else
    curl -s -X "$method" "$BASE$path" -H "authorization: Bearer $ADMIN"
  fi
}
admin_post() { admin_send POST "$1" "${2:-}"; }
admin_get()  { admin_send GET "$1"; }

(cd "$ROOT" && npm run build >/dev/null 2>&1)

if curl -sf "$BASE/healthz" >/dev/null 2>&1; then
  echo "port $PORT is already in use" >&2; exit 1
fi

cat > "$WORK/policies.yaml" <<'YAML'
version: 1
policies:
  - name: deploy-approval
    match:
      actions: ["deploy.*"]
      environments: ["production"]
    decision:
      effect: require_approval
      approvers: ["eng-lead"]
  - name: two-key-teardown
    match:
      actions: ["infrastructure.destroy"]
    decision:
      effect: require_approval
      approvers: ["eng-lead", "security"]
      minApprovals: 2
YAML

node "$ROOT/packages/cli/dist/index.js" serve \
  --policies "$WORK/policies.yaml" --data-dir "$WORK/data" --port "$PORT" \
  --admin-token "$ADMIN" --enforcement "default=enforce" > "$WORK/server.log" 2>&1 &
PID=$!
for _ in $(seq 1 40); do curl -sf "$BASE/healthz" >/dev/null 2>&1 && break; sleep 0.5; done
kill -0 "$PID" 2>/dev/null || { cat "$WORK/server.log" >&2; exit 1; }

AGENT=$(admin_post /v1/agents '{"name":"claude-code","kind":"claude-code"}' | jqf "d['token']")

echo
echo "== flow 1: an approval carries an action from held to allowed"
HELD=$(agent_post /v1/actions/check '{"action":"deploy.service","environment":"production","sessionId":"f1"}')
APPROVAL=$(echo "$HELD" | jqf "d.get('approvalId','')")
check "the action is held, not allowed" "$(echo "$HELD" | jqf "d['effect']")" "require_approval"
check "an approval id comes back" "$([[ -n "$APPROVAL" ]] && echo yes || echo no)" "yes"
check "it is pending" \
  "$(admin_get "/v1/approvals/$APPROVAL" | jqf "d['status']")" "pending"

admin_post "/v1/approvals/$APPROVAL" '{"approved":true,"resolvedBy":"eng-lead"}' >/dev/null
check "resolving marks it approved" \
  "$(admin_get "/v1/approvals/$APPROVAL" | jqf "d['status']")" "approved"

# The point of the whole flow: retrying with the grant now succeeds.
GRANTED_BODY=$(printf '{"action":"deploy.service","environment":"production","sessionId":"f1","approvalId":"%s"}' "$APPROVAL")
check "the same action now proceeds with the grant" \
  "$(agent_post /v1/actions/check "$GRANTED_BODY" | jqf "d['effect']")" "allow"
check "without the grant it is held again" \
  "$(agent_post /v1/actions/check '{"action":"deploy.service","environment":"production","sessionId":"f1b"}' | jqf "d['effect']")" "require_approval"

echo
echo "== flow 2: a denied approval keeps the action blocked"
DENIED=$(agent_post /v1/actions/check '{"action":"deploy.worker","environment":"production","sessionId":"f2"}' | jqf "d['approvalId']")
admin_post "/v1/approvals/$DENIED" '{"approved":false,"resolvedBy":"eng-lead"}' >/dev/null
DENIED_BODY=$(printf '{"action":"deploy.worker","environment":"production","sessionId":"f2","approvalId":"%s"}' "$DENIED")
check "a rejected approval does not authorize" \
  "$(agent_post /v1/actions/check "$DENIED_BODY" | jqf "d['effect']")" "block"

echo
echo "== flow 3: quorum needs two distinct people"
QUORUM=$(agent_post /v1/actions/check '{"action":"infrastructure.destroy","sessionId":"f3"}' | jqf "d['approvalId']")
admin_post "/v1/approvals/$QUORUM" '{"approved":true,"resolvedBy":"eng-lead"}' >/dev/null
check "one signature leaves it pending" \
  "$(admin_get "/v1/approvals/$QUORUM" | jqf "d['status']")" "pending"
admin_post "/v1/approvals/$QUORUM" '{"approved":true,"resolvedBy":"eng-lead"}' >/dev/null
check "the same person twice is still one signature" \
  "$(admin_get "/v1/approvals/$QUORUM" | jqf "d['status']")" "pending"
admin_post "/v1/approvals/$QUORUM" '{"approved":true,"resolvedBy":"security"}' >/dev/null
check "a second distinct person completes it" \
  "$(admin_get "/v1/approvals/$QUORUM" | jqf "d['status']")" "approved"

echo
echo "== flow 4: a plan narrows an agent step by step"
PLAN=$(agent_post /v1/plans '{"sessionId":"f4","steps":[{"name":"read","allows":["repository.read"]},{"name":"write","allows":["file.write"]}]}' | jqf "d['id']")
check "step one allows what it declared" \
  "$(agent_post /v1/actions/check '{"action":"repository.read","sessionId":"f4"}' | jqf "d['effect']")" "allow"
check "step one blocks what it did not" \
  "$(agent_post /v1/actions/check '{"action":"file.write","sessionId":"f4"}' | jqf "d['effect']")" "block"
agent_post "/v1/plans/$PLAN/advance" '' >/dev/null
check "advancing grants the next step" \
  "$(agent_post /v1/actions/check '{"action":"file.write","sessionId":"f4"}' | jqf "d['effect']")" "allow"
check "and revokes the previous one" \
  "$(agent_post /v1/actions/check '{"action":"repository.read","sessionId":"f4"}' | jqf "d['effect']")" "block"
agent_post "/v1/plans/$PLAN/close" '' >/dev/null
check "a closed plan allows nothing" \
  "$(agent_post /v1/actions/check '{"action":"file.write","sessionId":"f4"}' | jqf "d['effect']")" "block"

echo
echo "== flow 5: publish, then roll back to what ran before"
admin_send PUT /v1/policies '{"version":1,"policies":[{"name":"block-shell","match":{"actions":["shell.execute"]},"decision":{"effect":"block"}}]}' >/dev/null
FIRST=$(admin_get /v1/policies/history | jqf "d[0]['version']")
admin_send PUT /v1/policies '{"version":1,"policies":[{"name":"block-db","match":{"actions":["database.delete"]},"decision":{"effect":"block"}}]}' >/dev/null
check "the newest publish is in force" \
  "$(agent_post /v1/actions/check '{"action":"database.delete"}' | jqf "d['effect']")" "block"
check "the replaced rule is retired" \
  "$(agent_post /v1/actions/check '{"action":"shell.execute","target":"echo hi"}' | jqf "d['effect']")" "allow"
admin_post "/v1/policies/rollback/$FIRST" >/dev/null
check "rollback restores the earlier rule" \
  "$(agent_post /v1/actions/check '{"action":"shell.execute","target":"echo hi"}' | jqf "d['effect']")" "block"
check "and retires the one it replaced" \
  "$(agent_post /v1/actions/check '{"action":"database.delete"}' | jqf "d['effect']")" "allow"
check "the rollback is its own history entry" \
  "$(admin_get /v1/policies/history | jqf "'yes' if d[0].get('restoredFrom') else 'no'")" "yes"

echo
echo "== flow 6: the audit trail records the whole sequence"
check "every decision above is on the chain" \
  "$(admin_get /v1/audit/verify | jqf "str(d['valid']).lower()")" "true"
check "the trail names the approved deploy" \
  "$(admin_get "/v1/audit?limit=200" | jqf "'yes' if any(e['action']=='deploy.service' for e in d) else 'no'")" "yes"

echo
printf '== %d flows verified, %d failed\n' "$ok" "$bad"
[[ "$bad" -eq 0 ]]
