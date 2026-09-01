# Deployment

The same binary serves one developer and a whole organization. The difference is configuration rather than a different product.

| | Solo | Team |
|---|---|---|
| **Setup** | `npx memnox init && npx memnox serve` | one runtime per team, plus `memnox-cloud` |
| **Account required** | none | SSO through your IdP, at the control plane |
| **Storage** | JSON/JSONL files | JSON/JSONL files |
| **Approvals** | CLI | Slack buttons, RBAC API keys |
| **Audit** | hash-chained JSONL | the same chain, mirrored off the box |
| **Multi-org** | not applicable | `orgId` on every record |

Solo genuinely means zero infrastructure: no account, no API key, and no network call. A developer can govern their agents in two commands and never talk to a server that is not on their laptop. Everything above that is additive, so nothing about the solo path changes when a team adopts it.

## One process, one machine

A runtime is one process holding one audit chain, and there is no configuration
that changes that. File stores, per-process rate limits and an in-memory session
taint store are not defaults to be swapped out later; they are the only
implementations, and `VISION.md` §01 to §07 is deliberately built to need
nothing else.

```bash
memnox serve \
  --audit-retention-days 365 \    # hourly pruning sweep (0 keeps everything)
  --rate-limit 600
```

**Rate limiting.** The fixed-window counter is per-process. One process is the
whole deployment, so the configured limit is the real limit.

**Session taint.** The session taint store is in memory and never reconstructed
from the audit log. A restart forgets which sessions saw untrusted content.

**Audit retention.** `--audit-retention-days` prunes older events on an hourly
sweep against the local JSONL log.

**Multi-tenancy.** Agents, decisions, approvals and audit events carry an
optional `orgId`. Register with `{"orgId": "acme"}` and every event that agent
produces is stamped and filterable through `GET /v1/audit?org=acme`. Leaving it
unset keeps the single-tenant behavior.

Running more than one runtime, which is how more than one team is served, has its
own guide: [deploying many](deploying-many.md).

## Containers

Four build artifacts, one per deployment shape. All of them run unprivileged, keep `/data` as the only writable path, and refuse to start on a routable host without an admin token.

| Artifact | Runs |
|---|---|
| [`Dockerfile`](../Dockerfile) | The runtime alone. This is what `docker-compose.yml` builds. |
| [`Dockerfile.airgap`](../Dockerfile.airgap) | The runtime with `--enforcement default=enforce` and nothing in the decision path that reaches the network. |
| [`docker-compose.yml`](../docker-compose.yml) | One runtime, a data volume, and a read-only keyring mount. Files are the only backing store. |
| [`docker-compose.airgap.yml`](../docker-compose.airgap.yml) | The same, on an `internal: true` network with no route out, so the air-gap claim is verified by the topology instead of asserted. |

Copy [`.env.example`](../.env.example) first, because both compose files refuse to start until the admin token and the keyring path are set, since the container binds `0.0.0.0`:

```bash
cp .env.example .env
docker compose up
```

The keyring is mounted read-only and never committed. Losing it loses every record written under it, so back it up somewhere that is not this repository.

## Audit verification

Each event stores `prevHash` and `hash = sha256(canonical event + prevHash)`, computed at append time. Editing or deleting a record breaks the chain:

```bash
memnox audit verify
# Audit chain intact — 128401 events verified.
# …or: Audit chain BROKEN at event #91 (0f3a…): content-mismatch
```

`GET /v1/audit/verify` returns the same result as JSON. This is tamper *evidence* rather than tamper proofing, because it detects edits to a log you already control and does not stop an operator with write access to the data directory from rewriting the whole chain.

## Metrics

`GET /v1/metrics` serves Prometheus text with the counters the runtime already tracks: actions by effect and risk level, approvals pending and resolved, rate-limit rejections, and audit append failures. Counters are per-process, and one process is the whole runtime.

## Next

- [Connecting a control plane](connecting-a-control-plane.md)
- [Deploying more than one runtime](deploying-many.md)
- [Troubleshooting](troubleshooting.md)
