# Architecture

Memnox is built around one core primitive:

> **Every AI action becomes an event that Memnox can understand, evaluate, authorize, and prove.**

```
             AI Agents (MCP clients, SDK callers, custom)
                            |
        ┌─────────── interception ───────────┐
        │     MCP firewall     REST API      │   SDKs (TS / Python / Go)
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
                drafts policies · nothing else
```

## The decision pipeline

`ActionGateway.authorize()` (packages/runtime/src/action-gateway.ts) runs the same steps for every request. The gateway owns the pipeline; identity and approvals are collaborators it composes:

```
ActionGateway ──▶ AgentRegistry     identity, credentials, rotation
              └─▶ ApprovalService   raise, consent, quorum, break-glass
                        └─▶ evaluateConsent()   pure, in core
```


1. **Identity** — `AgentRegistry` resolves token → agent (bearer hash first, then service-account JWT). Unknown token: blocked, audited as critical. Suspended agent: blocked. An agent registered with `capabilities` (wildcard action patterns) is blocked before policy evaluation when the action matches none of them — even a granted approval cannot widen capabilities.
2. **Policy** — `PolicyEngine.evaluate()` collects every matching policy; the most restrictive effect wins (`withhold` > `escalate` > `allow`); no match → configured default effect. A rule may match on `scope`, the deterministic comparison of the request against the session's declared task, and a withholding rule may name the `alternative` it permits instead — resolved from the rule, never invented.
3. **Advisors** — deterministic escalators run next. An advisor may only *tighten* the decision, never loosen it, and an advisor failure means "no escalation", never a crash. With `--verification-guard`, the `VerificationAdvisor` does the same for destructive actions from an agent whose recent allowed decisions never reported an execution outcome.
4. **Approval** — `ApprovalService.requestFor()` creates or reuses a pending approval bound to the exact action fingerprint; the notifier port announces new ones. A policy may demand a quorum (`minApprovals`): grants accumulate, one person counts once, and a single denial ends it. When a request presents an `approvalId`, `ApprovalService.consentFor()` answers what that approval means — a lapsed pending approval is retired rather than treated as consent — and the gateway turns that verdict into a decision. When it presents none, the gateway claims an unspent grant matching the request fingerprint (`ApprovalService.claimGrantFor`), which is what closes the loop for an MCP client that has nowhere to carry an id. Either way the grant is marked `consumedAt`: **one grant authorizes one action**. An admin can break-glass (`POST /v1/approvals/:id/override` with a mandatory reason); the override is marked on the approval and appends a critical-risk audit event.
5. **Audit** — exactly one append-only event per action request: who, what, decision, risk, matched policies, `policyVersion`, advisory signals, session. The explanation is built from the same match and stored beside the decision, so `GET /v1/decision/:id/why` is a read rather than a retelling.

`POST /v1/evaluate-risk` runs steps 1–3 and stops: it reports what the verdict *would* be without auditing anything or creating an approval. Asking is not attempting.

`POST /v1/context` runs the same steps and renders them as a **briefing** — the constraints that govern the action, in the words whoever declared them used. It is the pre-flight half of the gate: an agent that asks first carries the rules into its work; one that does not meets them as a refusal. A briefing is a lookup, never generation — `buildActionBriefing` has no branch that invents a statement.

## Package map (vision layer → code)

| Vision layer | Package / entry point | Notes |
|---|---|---|
| 1. Runtime gateway + interception | `@memnox/runtime`, `@memnox/mcp-firewall`, `governTools` (`@memnox/sdk`) | The firewall gates `tools/call` and filters `tools/list`; `governTools` wraps any function-calling agent loop; the REST API serves everything else |
| 0. The machine | `@memnox/discovery`, `memnox` / `memnox doctor` / `memnox harden` | What can act here, what it reaches, what is risky, and the reversible change that closes each. No account, no network. Every detector is a pure function of a `MachineReader`; secrets are fingerprinted, never stored |
| 2. Agent identity | `@memnox/core` (AgentIdentity, `autonomyLevel`), `AgentRegistry`, runtime `/v1/agents` | Bearer tokens, service-account JWTs, mTLS. `POST /v1/agents/:id/rotate` issues a new credential and retires the old one on return. Authority is a named level a person granted, never a computed score; optional per-agent `capabilities` bound what an agent may attempt |
| 3. Policy engine | `@memnox/policy-engine` | Zero-dep, wildcard matching, YAML validation with full error lists. `versionPolicySet` content-hashes a rule set (stamped on every event as `policyVersion`); `comparePolicySets` powers `memnox policy simulate`; `POLICY_PACKS` are the in-tree reusable bundles |
| 4. Organizational memory | `@memnox/memory` (`DecisionRegistry`, `searchDecisions`, `DecisionSemanticSearch`, `VectorIndex`) | Team decisions as machine-checkable constraints; enforcement is pure pattern matching. Search is keyword by default and hybrid keyword+embedding when `--embedding-key` is set, degrading to keyword if the provider is unreachable |
| 5. Approvals | `ApprovalService` + `evaluateConsent` (core), runtime `/v1/approvals`, `ApprovalNotifier` port, Slack interactive endpoint | Fingerprint-bound, claimable without an id, and single-use. `minApprovals` gives the two-person rule: grants accumulate, one person counts once, a single denial ends it. Break-glass via `/v1/approvals/:id/override` — reason required, audited as critical, refused (403) for the non-overridable class |
| 6. Audit & accountability | `JsonlAuditLog`, sessions (`memnox replay`), `memnox report` (compliance markdown/JSON) | Append-only JSONL |
| 6b. Verified execution | `runGuarded` (`@memnox/sdk`), `POST /v1/actions/outcome`, `ActionGateway.recordOutcome` | Preconditions → action → postconditions → rollback. The outcome is the caller's testimony — the runtime cannot observe the outside world, so it records the claim and lets the log expose a decision that was never followed up. A failed rollback audits as critical |
| 3b. Declared intent | `Task`, `DeclaredScope`, `compareDeclaredScope` (core), runtime `/v1/tasks` | A session declares what it was asked for and the scope that implies. Scope is compared, never judged: an undeclared dimension is `undeclared`, not a guess, and no model is consulted on this path |
| 7. Risk | `classifyRisk` (policy-engine) + `@memnox/risk` (`BehaviorAdvisor`, `VerificationAdvisor`, `TaintAdvisor`, `AuthorityAdvisor`, `ShellIndirectionAdvisor`, `TokenBudgetAdvisor`) | Novel destructive actions, bursts, probing, prompt-injection taint gating, delegated-authority limits, session token budgets — all rule-based, all escalate-only |
| 2b. Capabilities | `Capability`, `Lease` (core), `CapabilityBroker` (runtime) | Nothing long lived is handed to an agent. A request is exchanged for a lease scoped to one operation and a few minutes, and every issue runs the ordinary decision path first, so the ledger says why a credential was held |
| 3c. Observe and learn | `@memnox/ledger` | Frames with hashed payloads, usage rolled up per action, unused grants, a least-privilege proposal in the format a person writes, lineage with a method on every hop, and a counterfactual derived from the attempt actually made |
| 8b. Execution | `@memnox/workflow` | Runs, steps and briefings, and the invariant that every route to a delegation passes a decision or an approval |
| 10b. Autonomy | `@memnox/autonomy` | Named levels a person granted, readiness as queries nobody can tick, rule synthesis from repeated approvals, and role economics that keep measured and modelled numbers apart |
| 7b. Pre-flight context | `POST /v1/context`, `ActionGateway.brief`, `buildActionBriefing` (core) | "What governs this?", answered before acting. Constraints are quoted from the policy set and decision corpus in the words whoever declared them used. No model, no inference, and no judgement about the work itself |
| 7c. Agent-facing tools | `memnox mcp` (`@memnox/cli`) | Memnox as an MCP server over stdio: `memnox_check_rules` and `memnox_status`. `McpServer` is message-in/message-out and owns no sockets, so the protocol is driven directly in tests. `memnox mcp install` writes the client config and never overwrites an existing `memnox` entry |
| 8. MCP security | `@memnox/mcp-firewall` | Transparent stdio proxy; static allow/deny + runtime checks; fail-closed by default |
| 9. Enterprise control plane | RBAC roles on the API (`viewer` / `approver` / `admin` via `apiKeys`) | Dashboards/multi-org are the commercial control plane |
| 10. Developer experience | `memnox`, `@memnox/sdk`, `sdks/python`, `sdks/go` | Local-first, no API key required to start |
| 11. Platform SDK | `@memnox/sdk` (`check`, `guard`, `guardVerified`, `governTools`, `RuntimeApi`), runtime `/v1/decision`, `/v1/authorize`, `/v1/evaluate-risk`, `/v1/policies` | `RuntimeApi` gives the predicate form (`canDeploy`, `canModify`, …). `ActionGateway` is embeddable in-process with in-memory stores |
| 12. Learning | `memnox insights` (local aggregates) | The cross-company learning network is commercial/roadmap |
| V2 intelligence | `@memnox/intelligence` (`PolicyDrafter`, `OrganizationExtractor`, `OpenAiEmbeddingProvider`) | BYOK (Anthropic / OpenAI): NL → validated policy drafts, structure extracted from a connected source, embeddings for search. Structurally incapable of deciding, and it no longer explains a decision or infers intent — `buildExplanation` and a declared `Task` replaced both |

## Dependency rules

```
discovery                            (zero deps)
core ← policy-engine ← memory
core ← org-graph ← risk
core ← ledger
core ← workflow
core ← autonomy
core + policy-engine + memory + risk ← runtime
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

### Encryption at rest: what is covered, and what is not

`--keyring-file` turns on AES-256-GCM with a random IV per record. The key id travels in the envelope (`enc:<keyId>:<base64>`), so one store can hold records written under several keys — which is what lets `memnox keys rewrap` move a store onto a new key incrementally instead of all at once. Keys derive through scrypt with a per-key salt, once at construction; deriving per read would be a denial-of-service surface.

Rotation is not, however, invisible to a running process. The runtime reads the keyring at boot and holds the derived keys for its lifetime, so the order is: add the key, **restart the runtime so it holds both**, then rewrap. Rewrapping under a live runtime that never saw the new key leaves it unable to read the records it just moved, and reads fail until it restarts.

The pre-keyring `--data-key` shape survives as the reserved key id `v1` with its original unsalted SHA-256 derivation, purely so existing deployments keep reading their own records. It cannot rotate, and the boot banner says so.

`--encryption-mode` decides what an envelope-less value means. `permissive` reads it and counts `memnox_plaintext_records_read_total`; that counter reaching zero is the signal that `strict` — which refuses — is safe. A deployment that calls itself encrypted and silently serves plaintext is exactly the failure this exists to expose.

**Encrypted:** the `record` blob of every agent, decision, approval, and audit event, in both the file and Postgres backends, plus the local policy history.

**Deliberately not encrypted, and this is a real limit rather than an oversight:**

- **Embeddings** (`decision_vectors`, `decision_embeddings`). A float array cannot be encrypted and stay ANN-searchable, and deterministic encryption of it is banned by rule 8 and would leak more than it protected. Embeddings are derived data that still leak topic and sometimes phrasing. They are protected by volume/database encryption and by the erasure path, not by the application codec.
- **Identifier and timestamp columns** (`id`, `seq`, `occurred_at`, `agent_id`, `session_id`, `org_id`, `project_id`, `fingerprint`, `status`). These are index keys; encrypting them would make every query a full scan. `token_hash` is already one-way.

So the honest description is **content encrypted, metadata in the clear** — not full-row encryption. Anyone with database access still learns which agents acted, when, and how often.

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
| Approval notifier failure | never affects the decision | Notification is best-effort; the audit log is the record |
