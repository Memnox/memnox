# @memnox/runtime

The gateway: the pipeline every agent action passes through, and the HTTP server
that exposes it.

## The pipeline

```
request → identity → policy → advisors → approval → audit → decision
```

Each stage can only make the outcome stricter. A request that survives every
stage is allowed; anything else is blocked or parked for a human.

## Three collaborators, not one class

| Class | Owns |
|---|---|
| `AgentRegistry` | identity: registration, credentials, rotation, token resolution, decision stats |
| `ApprovalService` | the approval lifecycle: raising, consent, quorum resolution, break-glass override |
| `ActionGateway` | the pipeline itself, composing the other two |

The seam that matters: whether consent *exists* is `ApprovalService`'s call and
rests on `evaluateConsent`, a pure function in `@memnox/core`. What to *do* with
that consent is the gateway's.

A grant is claimed by **fingerprint** (`agent | action | target | environment`), not
by id, so a caller with nowhere to carry an approval id — an editor hook, an MCP
client — still gets unblocked when a human approves. It is spent on use: one grant
authorizes one action. Capability bounds, suspension, and non-overridable taint
blocks all outrank a grant and leave it unspent.

Routes talk to the collaborator they need — `ctx.gateway.approvals.resolve(...)` —
rather than a pass-through method on the gateway.

## Running it

```ts
import { startServer } from '@memnox/runtime';

const server = await startServer({
  port: 8787,
  policyFile: 'memnox.policies.yaml',
  adminToken: process.env.MEMNOX_ADMIN_TOKEN,
});
```

Or from the CLI, which is how most people start:

```bash
npx memnox serve --policies memnox.policies.yaml
```

## Storage

Every store is a port defined in `@memnox/core`, with two implementations:

- **Local files** (default) — JSON and JSONL under `--data-dir`. Zero
  infrastructure; the runtime starts with nothing installed.
- **Postgres + Redis** — `--database-url` and `--redis-url` for multi-instance
  deployments that share state. See `@memnox/postgres` and `@memnox/redis`.

`--data-key` encrypts the local stores at rest with AES-256-GCM. Deterministic-IV
encryption is deliberately unavailable: pairing it with content search leaked
plaintext relationships in the predecessor codebase.

## Advisors

An `ActionAdvisor` is how new escalation logic enters the pipeline. Three rules,
enforced in review:

1. **Escalation-only.** An advisor may tighten a decision, never loosen it.
2. **Deterministic.** No clock, no network, no randomness.
3. **Failure means no escalation.** An advisor that throws is logged and skipped.
   It must never crash the gateway and never block everything.

Shipped advisors live in `@memnox/memory`, `@memnox/risk`, `@memnox/content-shield`,
and `@memnox/code-graph`.

## Audit

Every path through the gateway appends **exactly one** audit event, hash-chained
to its predecessor. `AuditChainVerifier` walks the chain and reports the first
broken link — `memnox audit verify`, or `GET /v1/audit/verify`.

## Layout

| Directory | Contents |
|---|---|
| `src/routes/` | one `<domain>.routes.ts` per area, each exporting `register<Domain>Routes` |
| `src/stores/` | file-backed implementations of the core ports |
| `src/` | `action-gateway.ts`, `approval-service.ts`, `agent-registry.ts`, `server.ts`, `reporting.ts` |
