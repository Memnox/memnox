# Deployment

There is one shape: **one process, one machine, one audit chain.** A developer
governing the agents on their laptop and a team running the runtime on a box are
the same binary with the same stores, and there is no configuration that changes
that.

Everything here works with no account, no API key and no network call. Nothing
leaves the machine, which is the whole reason a security engineer runs this on a
laptop holding production credentials.

## One process, one machine

File stores, per-process rate limits and an in-memory session taint store are not
defaults to be swapped out later; they are the only implementations. Serving more
than one team means more than one runtime, which is what an audit chain wants
anyway.

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

**At rest.** Nothing is encrypted at rest. Everything the runtime writes lands
under `--data-dir` with owner-only permissions, and that is the whole of the
protection: this is a runtime for one machine, and a key management story it
could not honestly promise to rotate would be worse than none.

## Containers

Four build artifacts, one per deployment shape. All of them run unprivileged,
keep `/data` as the only writable path, and refuse to start on a routable host
without an admin token.

| Artifact | Runs |
|---|---|
| [`Dockerfile`](../Dockerfile) | The runtime alone. This is what `docker-compose.yml` builds. |
| [`Dockerfile.airgap`](../Dockerfile.airgap) | The runtime with `--enforcement default=enforce` and nothing in the decision path that reaches the network. |
| [`docker-compose.yml`](../docker-compose.yml) | One runtime and a data volume. Files are the only backing store. |
| [`docker-compose.airgap.yml`](../docker-compose.airgap.yml) | The same, on an `internal: true` network with no route out, so the air-gap claim is verified by the topology instead of asserted. |

Copy [`.env.example`](../.env.example) first, because both compose files refuse
to start until the admin token is set — the container binds `0.0.0.0`:

```bash
cp .env.example .env
docker compose up
```

## Keyless local mode

With no `--admin-token` and no API keys, a runtime bound to loopback serves
management routes unauthenticated. That is deliberate: loopback is unreachable
from anywhere else, and asking a developer to mint a token before their first
decision is how a tool goes unused.

The moment the bind is routable, the runtime refuses to start without a
credential rather than serving admin routes to the network. It is worth setting
one on loopback too: with no keys configured every management request is treated
as admin, including one presenting an agent token, so a token is what stops the
agent you are governing from changing how it is governed.

## Audit verification

Each event stores `prevHash` and `hash = sha256(canonical event + prevHash)`,
computed at append time. Editing or deleting a record breaks the chain:

```bash
memnox audit verify
# Audit chain intact — 128401 events verified.
# …or: Audit chain BROKEN at event #91 (0f3a…): content-mismatch
```

`GET /v1/audit/verify` returns the same result as JSON. This is tamper *evidence*
rather than tamper proofing: it detects edits to a log you already control, and
does not stop an operator with write access to the data directory from
recomputing the whole chain.

## Metrics

`GET /v1/metrics` serves Prometheus text with the counters the runtime already
tracks: actions by effect and risk level, approvals pending and resolved,
rate-limit rejections, and audit append failures. Counters are per-process, and
one process is the whole runtime.

## Next

- [Troubleshooting](troubleshooting.md)
- [Operating](operating.md)
