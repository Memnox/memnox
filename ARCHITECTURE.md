# Architecture

Memnox is built around one core primitive:

> **Every AI action becomes an event that Memnox can understand, evaluate, authorize, and prove.**

```
        AI Agents (Claude Code, Cursor, MCP clients, custom)
                            |
        ┌─────────── interception ───────────┐
        │  Claude Code hook   MCP firewall   │   SDKs (TS / Python / Go)
        └──────────────────┬─────────────────┘
                           ↓
                    Memnox Runtime
                           |
     identity → policy → advisors → approval → audit
                           |
              ┌────────────┴────────────┐
              │   Deterministic layer   │   ← no LLM, ever
              └────────────┬────────────┘
                           |
                Intelligence layer (optional, BYOK)
                drafts policies · explains decisions
```

## The decision pipeline

`ActionGateway.authorize()` (packages/runtime/src/action-gateway.ts) runs the same steps for every request. The gateway owns the pipeline; identity and approvals are collaborators it composes:

```
ActionGateway ──▶ AgentRegistry     identity, credentials, rotation
              └─▶ ApprovalService   raise, consent, quorum, break-glass
                        └─▶ evaluateConsent()   pure, in core
```


1. **Identity** — `AgentRegistry` resolves token → agent (bearer hash first, then service-account JWT). Unknown token: blocked, audited as critical. Suspended agent: blocked. An agent registered with `capabilities` (wildcard action patterns) is blocked before policy evaluation when the action matches none of them — even a granted approval cannot widen capabilities.
2. **Policy** — `PolicyEngine.evaluate()` collects every matching policy; the most restrictive effect wins (`block` > `require_approval` > `allow`); no match → configured default effect.
3. **Advisors** — deterministic escalators run next. An advisor may only *tighten* the decision, never loosen it, and an advisor failure means "no escalation", never a crash. With `--trust-guard`, the `TrustAdvisor` requires approval for high/critical-risk actions from agents whose trust score has dropped below 60.
4. **Approval** — `ApprovalService.requestFor()` creates or reuses a pending approval bound to the exact action fingerprint; the notifier port announces new ones. A policy may demand a quorum (`minApprovals`): grants accumulate, one person counts once, and a single denial ends it. When a request presents an `approvalId`, `ApprovalService.consentFor()` answers what that approval means — a lapsed pending approval is retired rather than treated as consent — and the gateway turns that verdict into a decision. An admin can break-glass (`POST /v1/approvals/:id/override` with a mandatory reason); the override is marked on the approval and appends a critical-risk audit event.
5. **Audit** — exactly one append-only event per action request: who, what, decision, risk, matched policies, `policyVersion`, advisory signals, session.

`POST /v1/evaluate-risk` runs steps 1–3 and stops: it reports what the verdict *would* be without auditing anything or creating an approval. Asking is not attempting.

## Package map (vision layer → code)

| Vision layer | Package / entry point | Notes |
|---|---|---|
| 1. Runtime gateway + interception | `@memnox/runtime`, `memnox protect` (Claude Code + Cursor), `@memnox/mcp-firewall`, `governTools` (`@memnox/sdk`) | Claude Code hook exits 2 to deny; Cursor hooks map the three effects onto `allow`/`deny`/`ask`; the firewall gates `tools/call`; `governTools` wraps any function-calling agent loop |
| 2. Agent identity | `@memnox/core` (AgentIdentity, trust score), `AgentRegistry`, runtime `/v1/agents` | Bearer tokens, service-account JWTs, mTLS. `POST /v1/agents/:id/rotate` issues a new credential and retires the old one on return. Deterministic trust score consumed by `TrustAdvisor` (`--trust-guard`); optional per-agent `capabilities` bound what an agent may attempt |
| 3. Policy engine | `@memnox/policy-engine` | Zero-dep, wildcard matching, YAML validation with full error lists. `versionPolicySet` content-hashes a rule set (stamped on every event as `policyVersion`); `comparePolicySets` powers `memnox policy simulate`; `POLICY_PACKS` are the in-tree reusable bundles |
| 3b. Action understanding | `@memnox/code-graph` + `BlastRadiusAdvisor` | File-level import graph → transitive reachability. Escalates a code change by what it reaches, not just the path it names. Deliberately not symbol-level (see the package README) |
| 4. Organizational memory | `@memnox/memory` (`DecisionRegistry`, `searchDecisions`, `DecisionSemanticSearch`, `VectorIndex`) | Team decisions as machine-checkable constraints; enforcement is pure pattern matching. Search is keyword by default and hybrid keyword+embedding when `--embedding-key` is set, degrading to keyword if the provider is unreachable |
| 5. Approvals | `ApprovalService` + `evaluateConsent` (core), runtime `/v1/approvals`, `ApprovalNotifier` port, Slack interactive endpoint | Fingerprint-bound and replay-proof. `minApprovals` gives the two-person rule: grants accumulate, one person counts once, a single denial ends it. Break-glass via `/v1/approvals/:id/override` — reason required, audited as critical, refused (403) for the non-overridable class |
| 6. Audit & accountability | `JsonlAuditLog`, sessions (`memnox replay`), `memnox report` (compliance markdown/JSON) | Append-only JSONL |
| 6b. Verified execution | `runGuarded` (`@memnox/sdk`), `POST /v1/actions/outcome`, `ActionGateway.recordOutcome` | Preconditions → action → postconditions → rollback. The outcome is the caller's testimony — the runtime cannot observe the outside world, so it records the claim and lets the log expose a decision that was never followed up. A failed rollback audits as critical |
| 7. Risk | `classifyRisk` (policy-engine) + `@memnox/risk` (`BehaviorAdvisor`, `TrustAdvisor`, `TaintAdvisor`, `TokenBudgetAdvisor`, `DependencyAdvisor`) + `@memnox/content-shield` | Novel destructive actions, bursts, probing, prompt-injection taint gating, session token budgets — all rule-based. The shield scans written content and git diffs offline: secrets, credential/PII logging, SSN and Luhn-checked card numbers, `.env` credentials, and a curated vulnerable-package table. Rules are routed by path kind (code / manifest / lockfile / env / minified / sample) and stamped with `SHIELD_RULESET_VERSION` so a verdict can be reproduced. Used by the `ContentShieldAdvisor`, the `memnox hook` pre-write delta filter, and `memnox ci` |
| 8. MCP security | `@memnox/mcp-firewall` | Transparent stdio proxy; static allow/deny + runtime checks; fail-closed by default |
| 9. Enterprise control plane | RBAC roles on the API (`viewer` / `approver` / `admin` via `apiKeys`) | Dashboards/multi-org are the commercial control plane |
| 10. Developer experience | `@memnox/cli`, `@memnox/sdk`, `sdks/python`, `sdks/go` | Local-first, no API key required to start |
| 11. Platform SDK | `@memnox/sdk` (`check`, `guard`, `guardVerified`, `governTools`, `RuntimeApi`), runtime `/v1/decision`, `/v1/authorize`, `/v1/evaluate-risk`, `/v1/policies` | `RuntimeApi` gives the predicate form (`canDeploy`, `canModify`, …). `ActionGateway` is embeddable in-process with in-memory stores |
| 12. Learning | `memnox insights` (local aggregates) | The cross-company learning network is commercial/roadmap |
| V2 intelligence | `@memnox/intelligence` (`PolicyDrafter`, `DecisionExplainer`, `IntentClassifier`, `OpenAiEmbeddingProvider`) | BYOK (Anthropic / OpenAI): NL → validated policy drafts, decision explanations, goal → candidate actions, embeddings for search. Structurally incapable of making decisions — `IntentClassifier` proposes actions but `classifyRisk` rates them |

## Dependency rules

```
core ← policy-engine ← memory
core ← content-shield ← risk
core + policy-engine ← code-graph
core + policy-engine + memory + risk + code-graph ← runtime
core ← sdk ← mcp-firewall
core + policy-engine ← intelligence
core ← memory ← postgres
everything ← cli
```

- `core` and `policy-engine` have **zero** runtime dependencies — the trust-critical code is fully inspectable.
- Packages import each other only through their public `index.ts`.
- The decision path (`policy-engine`, `action-gateway`) makes no network calls, reads no clock as input to a verdict, and uses no randomness.

## mTLS agent authentication (opt-in)

`memnox serve --tls-cert <path> --tls-key <path> --tls-ca <path>` (or `MEMNOX_TLS_CERT` / `MEMNOX_TLS_KEY` / `MEMNOX_TLS_CA`) starts the runtime over HTTPS with `requestCert: true`. The socket does not reject unverified peers — instead, each `/v1/actions/check` request without a bearer token is authenticated from its CA-verified client certificate: the subject CN is mapped to the agent with that name (`resolveAgentFromClientCert`). A bearer token, when present, always takes precedence. No cert or an unverified/unknown CN without a token → 401.

## Scale and storage

The zero-infrastructure path (JSON/JSONL files, in-process locks) is the default and stays supported. `--database-url` and `--redis-url` are what a multi-pod deployment adds.

### Bounded audit reads

`AuditQuery` carries a `limit`. Advisors on the authorize path each pass their own named window (`BASELINE_WINDOW_EVENTS`, `TOKEN_BUDGET_WINDOW_EVENTS`) instead of reading a full history and slicing it. `TaintAdvisor` reads no history at all — see the session taint store below. Postgres pushes the bound into SQL (`ORDER BY occurred_at DESC, seq DESC LIMIT n`, then reversed back to chronological); the JSONL adapter reads the file backwards in chunks. `audit_events.seq` (BIGSERIAL) is the tie-break that makes append order total — ISO timestamps collide inside a millisecond.

Indexes: `audit_events (agent_id, occurred_at DESC)`, `(session_id, occurred_at DESC)`, `(org_id, occurred_at DESC)`; `decisions (decided_at)` and `(org_id, decided_at)`; `approvals (status, fingerprint)`, `(status, created_at)`, `(org_id)`; `agents (token_hash)`, `(org_id)`. Schema bootstrap is additive and idempotent — `CREATE TABLE` when missing, then `ADD COLUMN IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` on every start.

### Session taint store

Provenance classification is pure and lives in `core` (`classifySourceTaint`, `isRecordTainted`): source type first (`NEVER_TAINTED_SOURCE_TYPES` are ground truth, `ALWAYS_TAINTED_SOURCE_TYPES` are third-party free text), then the actor (GitHub `author_association`, Slack workspace membership), then a source-authority threshold. Actor facts are resolved by the ingestion path and passed in — the classifier performs no lookups and takes no dependencies.

Accumulated session taint lives behind the `SessionTaintStore` port: `read` returns the session's taint plus an `available` flag, `merge` folds new taint in monotonically. `InMemorySessionTaintStore` (core) is the zero-infrastructure default; `RedisSessionTaintStore` (`@memnox/redis`, selected by `--redis-url`) does a lock-guarded read-merge-write with a `TAINT_SESSION_TTL_S` (7-day) TTL and caps stored refs at `TAINT_MAX_SOURCE_REFS`. A corrupt payload or an unreachable backend reports **tainted**, never clean.

This replaced an audit-log rescan: the advisor used to reconstruct session taint by querying the last N events on every single action, which is O(session length) per request and grows without bound. `TaintAdvisor` now issues zero audit queries.

`TAINT_NO_OVERRIDE_ACTIONS` is the non-overridable class. A tainted session attempting one gets an advisory with `escalateTo: block` and `nonOverridable: true`; `ActionGateway` checks for that advisory before applying any approval, so an already-granted approval cannot unblock it, and `overrideApproval` refuses break-glass for that action class outright and audits the refusal as critical.

### Retention, not partitioning

`AuditLog.pruneBefore(cutoff)` drops events past a horizon; `--audit-retention-days` schedules it hourly behind the `LockService` so exactly one pod sweeps. Postgres deletes in bounded batches (`DELETE … WHERE id IN (SELECT id … LIMIT n)`) so the table is never locked for long; JSONL rewrites into a sibling file and renames.

**Native table partitioning is deliberately not implemented.** Declarative partitioning on `audit_events` means a table rewrite and a real migration story, which this project does not have yet (bootstrap is idempotent DDL, not versioned migrations). Retention keeps the table bounded in the meantime. The next step, when it is needed, is monthly `RANGE` partitions on `occurred_at` with detach-instead-of-delete retention — which also makes pruning O(1).

### Tenancy: a column, for now

`agents`, `decisions`, `approvals`, and `audit_events` carry a **nullable** `org_id`, populated from the acting agent's `orgId` and filterable in queries. Null means single-tenant, so every existing deployment behaves exactly as before. This is the cheapest thing that makes one process serve several orgs and makes per-org evidence exportable.

It is not isolation. The application, not the database, is what keeps orgs apart — a missing filter is a leak. When that trade stops being acceptable the scale-out options are Postgres row-level security (policies keyed on a session variable, enforcement moves into the database) or a schema/database per tenant (strongest isolation, most operational cost). Both are compatible with the column; neither is implemented.

### Tamper-evident audit

Every appended event stores `prevHash` and `hash = sha256(canonicalJson(event) + prevHash)`, computed at append time in the adapter (`chainAuditEvent` in core). `verifyChain()` walks the log — streaming in pages on Postgres — and reports the first broken link with its index, id, and reason (`missing-hash`, `prev-hash-mismatch`, `content-mismatch`). Verification anchors on the first retained event's own `prevHash`, so a retention-pruned prefix still verifies. Surfaced as `GET /v1/audit/verify` and `memnox audit verify`.

Honest limits: no signatures and no Merkle tree, so anyone who can write the store can also recompute a consistent chain — this catches edits, not a determined operator. On Postgres the chain tip is read per append, so two pods appending in the same instant can fork the chain; verification reports that fork rather than hiding it.

### Metrics

`GET /v1/metrics` renders a small in-process counter registry as Prometheus text: actions by effect and risk level, approvals pending/resolved, rate-limit rejections, audit append failures. Deliberately per-process — cross-pod aggregation belongs to the scrape layer, not to the runtime.

## Fail-open vs fail-closed

| Surface | Default | Why |
|---|---|---|
| Unknown agent token | fail closed | Cannot prove identity → block |
| Advisors | escalation-only | A broken advisor must not brick or bypass anything |
| Session taint store unreadable | fail closed | Provenance that cannot be proven clean is treated as tainted — the one exception to the row above |
| MCP firewall, runtime unreachable | fail closed (`MEMNOX_MCP_FAIL_OPEN=true` to override) | A firewall that fails open is not a firewall |
| Claude Code hook, runtime unreachable | fail open (`MEMNOX_HOOK_FAIL_CLOSED=true` to override) | A hook must never be the reason an editor stops working |
| Approval notifier failure | never affects the decision | Notification is best-effort; the audit log is the record |
