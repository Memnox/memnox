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
3. **Advisors** — the `ActionAdvisor` port runs next. An advisor may only *tighten* the decision, never loosen it, and an advisor failure means "no escalation", never a crash. None ships with the runtime; the port is here for the ones a deployment writes itself.
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
| 5. Approvals | `ApprovalService` + `evaluateConsent` (core), runtime `/v1/approvals`, `ApprovalNotifier` port, Slack interactive endpoint | Fingerprint-bound, claimable without an id, and single-use. `minApprovals` gives the two-person rule: grants accumulate, one person counts once, a single denial ends it. Break-glass via `/v1/approvals/:id/override` — reason required, audited as critical, refused (403) for the non-overridable class |
| 6. Audit & accountability | `JsonlAuditLog`, sessions (`memnox replay`), `GET /v1/audit` (CSV) | Append-only JSONL |
| 6b. Verified execution | `runGuarded` (`@memnox/sdk`), `POST /v1/actions/outcome`, `ActionGateway.recordOutcome` | Preconditions → action → postconditions → rollback. The outcome is the caller's testimony — the runtime cannot observe the outside world, so it records the claim and lets the log expose a decision that was never followed up. A failed rollback audits as critical |
| 3d. Learn | `LearnService`, runtime `GET /v1/learn`, `memnox learn` | Usage against grant over a stated window. What was tried and refused is reported apart from what was never touched, because a rule already refusing something needs no second rule proposing to |
| 6b. Containment | `ContainmentService`, `POST /v1/containment`, `memnox kill` / `quarantine` / `panic` | Records which installs it reached and which it did not; the CLI exits non-zero on a partial containment. Panic is refused without a restore path |
| 6c. Delegation | `DelegationService`, `canDelegate`, `chainOf` (core) | A chain can only narrow, checked at issue and again at use. Revoking a parent kills every child at use time |
| 9b. Coverage | `coverageFrom` (runtime), `GET /v1/coverage`, `memnox coverage` | Distinct actions governed over seen, weighted by risk, times seam coverage, times install coverage. Zero seams is zero coverage, and the output says why |
| 3b. Declared intent | `Task`, `DeclaredScope`, `compareDeclaredScope` (core), runtime `/v1/tasks` | A session declares what it was asked for and the scope that implies. Scope is compared, never judged: an undeclared dimension is `undeclared`, not a guess, and no model is consulted on this path |
| 7. Risk | `classifyRisk` (policy-engine) | Destructive actions are classified by rule on the decision path. The `ActionAdvisor` port is still there; no advisor ships with the local runtime |
| 2b. Capabilities | `Capability`, `Lease` (core), `CapabilityBroker` (runtime) | Nothing long lived is handed to an agent. A request is exchanged for a lease scoped to one operation and a few minutes, and every issue runs the ordinary decision path first, so the ledger says why a credential was held |
| 3c. Observe and learn | `@memnox/ledger` | Frames with hashed payloads, usage rolled up per action, unused grants, a least-privilege proposal in the format a person writes, lineage with a method on every hop, and a counterfactual derived from the attempt actually made |
| 7b. Pre-flight context | `POST /v1/context`, `ActionGateway.brief`, `buildActionBriefing` (core) | "What governs this?", answered before acting. Constraints are quoted from the policy set and decision corpus in the words whoever declared them used. No model, no inference, and no judgement about the work itself |
| 7c. Agent-facing tools | `memnox mcp` (`@memnox/cli`) | Memnox as an MCP server over stdio: `memnox_check_rules` and `memnox_status`. `McpServer` is message-in/message-out and owns no sockets, so the protocol is driven directly in tests. `memnox mcp install` writes the client config and never overwrites an existing `memnox` entry |
| 8. MCP security | `@memnox/mcp-firewall` | Transparent stdio proxy, **both directions**: the call is gated on the way out and the result inspected on the way back, wrapped as an untrusted context block and framed rather than edited. The alternative rides in the denial the client reads. Static allow/deny + runtime checks; fail-closed by default |
| 9. Enterprise control plane | RBAC roles on the API (`viewer` / `approver` / `admin` via `apiKeys`) | Dashboards/multi-org are the commercial control plane |
| 10. Developer experience | `memnox`, `@memnox/sdk` | Local-first, no API key required to start |
| 11. Platform SDK | `@memnox/sdk` (`check`, `guard`, `guardVerified`, `governTools`, `RuntimeApi`), runtime `/v1/decision`, `/v1/authorize`, `/v1/evaluate-risk`, `/v1/policies` | `RuntimeApi` gives the predicate form (`canDeploy`, `canModify`, …). `ActionGateway` is embeddable in-process with in-memory stores |

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

## Storage

One process, one machine, one audit chain. JSON and JSONL files under
`--data-dir` are the only implementation of every store port, and in-process
locks the only implementation of `LockService`. There is no shared-database
path and no multi-pod path: `VISION.md` §01 to §07 is built so that neither is
needed, and serving more than one team means [more than one
runtime](docs/deploying-many.md) rather than a bigger one.

### Bounded audit reads

`AuditQuery` carries a `limit`, and the JSONL adapter reads the file backwards
in chunks rather than loading a history and slicing it.

### Session taint store

Provenance classification is pure and lives in `core` (`classifySourceTaint`, `isRecordTainted`): source type first (`NEVER_TAINTED_SOURCE_TYPES` are ground truth, `ALWAYS_TAINTED_SOURCE_TYPES` are third-party free text), then the actor (GitHub `author_association`, Slack workspace membership), then a source-authority threshold. Actor facts are resolved by the ingestion path and passed in — the classifier performs no lookups and takes no dependencies.

Accumulated session taint lives behind the `SessionTaintStore` port: `read` returns the session's taint plus an `available` flag, `merge` folds new taint in monotonically. `InMemorySessionTaintStore` (core) is the only implementation: one process, one machine, nothing shared, and nothing survives a restart. A corrupt payload reports **tainted**, never clean.

**Taint is recorded, not enforced.** The advisor that escalated on it went with `@memnox/risk`. A tainted session is framed and stored, and `TAINT_NO_OVERRIDE_ACTIONS` still names the non-overridable class, but no shipped code turns taint into an escalation. Restoring that is a rule in the policy engine or a deployment's own `ActionAdvisor`.

### Retention

`AuditLog.pruneBefore(cutoff)` drops events past a horizon; `--audit-retention-days` schedules it hourly behind the `LockService`. The JSONL log rewrites into a sibling file and renames.

### Tenancy: a column, for now

`agents`, `decisions`, `approvals`, and `audit_events` carry a **nullable** `orgId`, populated from the acting agent's `orgId` and filterable in queries. Null means single-tenant, so every existing deployment behaves exactly as before.

It is not isolation. The application is what keeps orgs apart — a missing filter is a leak. Where that trade stops being acceptable, the answer is one runtime per tenant, which is what the audit chain wants anyway.


### Encryption at rest: what is covered, and what is not

`--keyring-file` turns on AES-256-GCM with a random IV per record. The key id travels in the envelope (`enc:<keyId>:<base64>`), so one store can hold records written under several keys — so a store can be moved onto a new key incrementally instead of all at once. Keys derive through scrypt with a per-key salt, once at construction; deriving per read would be a denial-of-service surface.

Rotation is not, however, invisible to a running process. The runtime reads the keyring at boot and holds the derived keys for its lifetime, so the order is: add the key, **restart the runtime so it holds both**, then rewrap. Rewrapping under a live runtime that never saw the new key leaves it unable to read the records it just moved, and reads fail until it restarts.

The pre-keyring `--data-key` shape survives as the reserved key id `v1` with its original unsalted SHA-256 derivation, purely so existing deployments keep reading their own records. It cannot rotate, and the boot banner says so.

`--encryption-mode` decides what an envelope-less value means. `permissive` reads it and counts `memnox_plaintext_records_read_total`; that counter reaching zero is the signal that `strict` — which refuses — is safe. A deployment that calls itself encrypted and silently serves plaintext is exactly the failure this exists to expose.

**Encrypted:** the `record` blob of every agent, decision, approval, and audit event, plus the local policy history.

**Deliberately not encrypted, and this is a real limit rather than an oversight:**

- **Embeddings** (`decision_vectors`, `decision_embeddings`). A float array cannot be encrypted and stay ANN-searchable, and deterministic encryption of it is banned by rule 8 and would leak more than it protected. Embeddings are derived data that still leak topic and sometimes phrasing. They are protected by volume/database encryption and by the erasure path, not by the application codec.
- **Identifier and timestamp columns** (`id`, `seq`, `occurred_at`, `agent_id`, `session_id`, `org_id`, `project_id`, `fingerprint`, `status`). These are index keys; encrypting them would make every query a full scan. `token_hash` is already one-way.

So the honest description is **content encrypted, metadata in the clear** — not full-row encryption. Anyone with database access still learns which agents acted, when, and how often.

### Tamper-evident audit

Every appended event stores `prevHash` and `hash = sha256(canonicalJson(event) + prevHash)`, computed at append time in the adapter (`chainAuditEvent` in core). `verifyChain()` walks the log and reports the first broken link with its index, id, and reason (`missing-hash`, `prev-hash-mismatch`, `content-mismatch`). Verification anchors on the first retained event's own `prevHash`, so a retention-pruned prefix still verifies. Surfaced as `GET /v1/audit/verify` and `memnox audit verify`.

Honest limits: no signatures and no Merkle tree, so anyone who can write the data directory can also recompute a consistent chain — this catches edits, not a determined operator.

### Metrics

`GET /v1/metrics` renders a small in-process counter registry as Prometheus text: actions by effect and risk level, approvals pending/resolved, rate-limit rejections, audit append failures. Deliberately per-process, and one process is the whole runtime.

## Fail-open vs fail-closed

| Surface | Default | Why |
|---|---|---|
| Unknown agent token | fail closed | Cannot prove identity → block |
| Advisors | escalation-only | A broken advisor must not brick or bypass anything |
| Session taint store unreadable | fail closed | Provenance that cannot be proven clean is treated as tainted — the one exception to the row above |
| MCP firewall, runtime unreachable | fail closed (`MEMNOX_MCP_FAIL_OPEN=true` to override) | A firewall that fails open is not a firewall |
| Approval notifier failure | never affects the decision | Notification is best-effort; the audit log is the record |
