#!/bin/sh
# Seeds starter policies on a fresh volume so the first run starts governed
# rather than crash-looping on a missing file.
set -e
POLICIES=/data/memnox.policies.yaml
[ -f "$POLICIES" ] || node packages/cli/dist/index.js init --file "$POLICIES"
exec node packages/cli/dist/index.js serve \
  --host 0.0.0.0 --data-dir /data --policies "$POLICIES" "$@"
