# Deployment

The same binary serves one developer and a whole organization. The difference is configuration rather than a different product.

| | Solo | Team | Enterprise |
|---|---|---|---|
| **Setup** | `npx memnox init && npx memnox serve` | `--database-url` and `--redis-url` | above, plus `memnox-cloud` |
| **Account required** | none | none | SSO through your IdP |
| **Storage** | JSON/JSONL files | shared Postgres | Postgres with a retention policy |
| **Approvals** | CLI | Slack buttons, RBAC API keys | Slack and OIDC identities |
| **Audit** | hash-chained JSONL | shared and verifiable | plus CSV/compliance export and retention |
| **Multi-org** | not applicable | not applicable | `orgId` on every record |

Solo genuinely means zero infrastructure: no account, no API key, and no network call. A developer can protect their editor in two commands and never talk to a server that is not on their laptop. Everything above that is additive, so nothing about the solo path changes when a team adopts it.

## Running it at scale

The zero-infrastructure defaults, meaning file stores, per-process rate limits, and a keep-everything audit, are built for one process. Four flags turn the same binary into a horizontally scaled deployment:

```bash
memnox serve \
  --database-url postgres://…      # or MEMNOX_DATABASE_URL, for shared identity, approvals, audit
  --redis-url redis://…            # or MEMNOX_REDIS_URL, for one rate-limit budget across all pods
  --audit-retention-days 365 \     # hourly pruning sweep, batched, lock-guarded (0 keeps everything)
  --rate-limit 600
```

**Rate limiting.** Without `--redis-url` each pod counts on its own, so N pods means N times the configured limit. With it, the fixed-window counter lives in Redis and every pod shares one budget. If the URL is set but Redis is unreachable, startup fails rather than silently degrading.

**Session taint.** `--redis-url` also moves the session taint store into Redis, using a lock-guarded read-merge-write with a 7-day TTL, so a session that saw untrusted content stays tainted on every pod. Without it the store is per-process. It is never reconstructed from the audit log.

**Audit retention.** `--audit-retention-days` prunes older events on an hourly sweep. The Postgres delete is batched so it never holds a long table lock, and one distributed lock keeps a single pod sweeping at a time. Native table partitioning is not implemented; see [ARCHITECTURE.md](../ARCHITECTURE.md).

**Bounded reads.** Advisors ask for a fixed recent window instead of an agent's whole history, and the bound is pushed into SQL (`ORDER BY occurred_at DESC LIMIT n`) rather than applied afterwards.

**Multi-tenancy.** Agents, decisions, approvals, and audit events carry an optional `orgId`, stored as a nullable indexed `org_id` column. Register with `{"orgId": "acme"}` and every event that agent produces is stamped and filterable through `GET /v1/audit?org=acme`. Leaving it unset keeps the existing single-tenant behavior.

Running more than one runtime has its own guide: [deploying many](deploying-many.md).

## Containers

Five build artifacts, one per deployment shape. All of them run unprivileged, keep `/data` as the only writable path, and refuse to start on a routable host without an admin token.

| Artifact | Runs |
|---|---|
| [`Dockerfile`](../Dockerfile) | The runtime alone. This is what `docker-compose.yml` builds. |
| [`Dockerfile.allinone`](../Dockerfile.allinone) | Runtime plus Graphify in one image, giving deeper blast radius with no host Python to reconcile. Mount the repository read-only, since the graph is written to `/data` and never into your working tree. |
| [`Dockerfile.airgap`](../Dockerfile.airgap) | The runtime with `--enforcement default=enforce` and nothing in the decision path that reaches the network. |
| [`docker-compose.yml`](../docker-compose.yml) | One runtime, a data volume, and a read-only keyring mount. Postgres and the all-in-one service ship commented out, so uncomment either one to enable it. |
| [`docker-compose.airgap.yml`](../docker-compose.airgap.yml) | The same, on an `internal: true` network with no route out, so the air-gap claim is verified by the topology instead of asserted. |

Copy [`.env.example`](../.env.example) first, because both compose files refuse to start until the admin token and the keyring path are set, since the container binds `0.0.0.0`:

```bash
cp .env.example .env
memnox keys generate --keyring-file memnox-keyring.json
docker compose up
```

The keyring is mounted read-only and never committed. Losing it loses every record written under it, so back it up somewhere that is not this repository. The all-in-one image bundles Graphify, so it carries both licences at `/app/THIRD-PARTY-NOTICES.md`.

## Audit verification

Each event stores `prevHash` and `hash = sha256(canonical event + prevHash)`, computed at append time. Editing or deleting a record breaks the chain:

```bash
memnox audit verify
# Audit chain intact — 128401 events verified.
# …or: Audit chain BROKEN at event #91 (0f3a…): content-mismatch
```

`GET /v1/audit/verify` returns the same result as JSON. This is tamper *evidence* rather than tamper proofing, because it detects edits to a log you already control and does not stop an operator with database access from rewriting the whole chain.

## Metrics

`GET /v1/metrics` serves Prometheus text with the counters this pod already tracks: actions by effect and risk level, approvals pending and resolved, rate-limit rejections, and audit append failures. Counters are per-process, so summing across pods is the scrape layer's job.

## Next

- [Connecting a control plane](connecting-a-control-plane.md)
- [Deploying more than one runtime](deploying-many.md)
- [Troubleshooting](troubleshooting.md)
