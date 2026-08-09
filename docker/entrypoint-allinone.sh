#!/bin/sh
# Seeds starter policies, then builds a code graph from the mounted repository
# before serving, so blast radius works on the first request rather than after
# someone remembers to run two more commands.
set -e

POLICIES=${MEMNOX_POLICIES:-/data/memnox.policies.yaml}
REPO=${MEMNOX_REPO:-}
SNAPSHOT=/data/code-graph.json

[ -f "$POLICIES" ] || node packages/cli/dist/index.js init --file "$POLICIES"

GRAPH_ARGS=""
if [ -n "$REPO" ] && [ -d "$REPO" ]; then
  # --out keeps every write inside /data, so the repository can be mounted
  # read-only. --no-cluster is the AST-only path: no LLM, no network, no API key.
  if graphify extract "$REPO" --out /data --no-cluster >/dev/null 2>&1 \
    && node packages/cli/dist/index.js graphify use /data --out "$SNAPSHOT" >/dev/null 2>&1
  then
    GRAPH_ARGS="--code-graph $SNAPSHOT"
    echo "[memnox] code graph built from $REPO via Graphify"
  else
    # A repository we cannot parse is not a reason to refuse to govern it.
    echo "[memnox] could not build a code graph from $REPO — serving without one"
  fi
fi

exec node packages/cli/dist/index.js serve \
  --host 0.0.0.0 --data-dir /data --policies "$POLICIES" $GRAPH_ARGS "$@"
