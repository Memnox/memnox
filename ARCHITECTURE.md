# Architecture

Memnox is built around one core primitive:

> **Every AI action becomes an event that Memnox can understand, evaluate, authorize, and prove.**

```
             AI Agents (MCP clients, SDK callers, custom)
                            |
        ┌─────────── interception ───────────┐
        │  MCP firewall  tool hook  REST API │   SDK (TypeScript)
        └──────────────────┬─────────────────┘
                           ↓
                    Memnox Runtime
                           |
     identity → policy → advisors → approval → audit
                           |
              ┌────────────┴────────────┐
              │   Deterministic layer   │   ← no LLM, ever
              └─────────────────────────┘
```

This repository is the **open half**: everything one person needs to govern the
agents on their own machine, with no account and no network. The line is drawn
on a principle rather than a feature count — anything that only means something
across more than one person, and that needs somebody else's data to work, is the
cloud and is not here. See the open/cloud table in `VISION.md`.

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

## Package map (situation → code)

Situations are cited by number from `VISION.md`; the phase index there maps each `§NN` to the situations it closes.

| Situations | Package / entry point | Notes |
|---|---|---|
| 01, 07 — what can act here | `@memnox/discovery`, `memnox` / `memnox doctor` / `memnox harden` / `memnox readiness` | What can act here, what it reaches, what is risky, and the reversible change that closes each. No account, no network. Every detector is a pure function of a `MachineReader`; secrets are fingerprinted, never stored. `readinessFor` answers "can it deploy" from credentials, tooling and reach rather than from the agent's own account of itself |
| 02, 09, 10, 11 — what quietly grew | `snapshotOf`, `compareSnapshots`, `NodeSnapshotStore`, `traceCapability`, `memnox watch` / `diff` / `trace` | Every scan is reduced to an `EnvironmentSnapshot` and kept under the Memnox root, which is the only reason a second run has a baseline. Changes carry a direction, so a list never mixes a new credential with a removed one, and a trace dates an arrival against the scan history rather than a file's mtime |
| 04, 05 — autonomy without blind trust | `@memnox/policy-engine`, `ApprovalService`, `memnox approvals` | Zero-dep, wildcard matching, YAML validation with full error lists. `versionPolicySet` content-hashes a rule set (stamped on every event as `policyVersion`); `comparePolicySets` powers `memnox policy simulate`; `POLICY_PACKS` are the in-tree reusable bundles |
| 06 — why | `buildExplanation` (core), `GET /v1/decision/:id/why`, `memnox why`, `memnox rules` | Built from the decision, the request and the scope comparison. An explanation a model wrote afterwards is a plausible story about a decision, which is worse than none |
| 08 — it holds more than it needs | `LearnService`, `GET /v1/learn`, `memnox learn` | Usage against grant over a stated window. What was tried and refused is reported apart from what was never touched, because a rule already refusing something needs no second rule proposing to |
| 12, 13, 14 — what it actually did | `@memnox/ledger`, `JsonlAuditLog`, `LineageService`, `memnox audit` / `replay` | Frames with hashed payloads, usage rolled up per action, lineage with a method on every hop, and a counterfactual derived from the attempt actually made |
| 03 — which tools are dangerous | `inferToolEffect` (discovery), `memnox --tools` | Every tool by effect, server by server, with the method that decided it. Read from the protocol's annotation where a server publishes one and inferred from the name where it does not. An unclassified tool is counted as neither, because an inferred blank is not evidence of harm |
| 12, 13 — what it did, and its own account of it | `JsonlFrameStore`, `timelineOf`, `GET /v1/sessions/:id/frames`, `memnox replay` | One session, one timeline, assembled from what the seams intercepted. Where the agent's reported outcome disagrees with the record — a claimed success on a withheld action — the seam wins and `replay` says so |
| 15 — which agent did this | `AgentIdentity` (kind, role, principal), `AgentRegistry`, `/v1/agents` | Three fields, all required before enrolment: the kind is the product, the role is the job, the principal is the person it acts for. Policy matches on `roles`, so swapping the product leaves every rule about the job standing. `POST /v1/agents/:id/rotate` issues a new credential and retires the old one |
| 16, 17 — two agents, one piece of work | `concurrentWork`, `overlappingWork` (`@memnox/ledger`), `memnox collisions` | Read out of the ledger, because both agents act through seams that record what they touched. Reported, never refereed: opening the diff to decide which of them is right is code review, and out of scope permanently |
| interception | `@memnox/mcp-firewall`, `@memnox/tool-hook`, `governTools` (`@memnox/sdk`) | The firewall gates `tools/call` **both ways** and filters `tools/list`; the tool hook holds the five local seams; `governTools` wraps any function-calling agent loop |
| seams and coverage | `SeamService`, `coverageFrom`, `GET /v1/coverage`, `memnox coverage` | Distinct actions governed over seen, weighted by risk, times seam coverage, times install coverage. Zero seams is zero coverage, and the output says why |
| containment | `ContainmentService`, `POST /v1/containment`, `memnox kill` / `quarantine` / `panic` | Records which installs it reached and which it did not; the CLI exits non-zero on a partial containment. Panic is refused without a restore path |
| declared intent | `Task`, `DeclaredScope`, `compareDeclaredScope` (core), `/v1/tasks` | A session declares what it was asked for and the scope that implies. Scope is compared, never judged: an undeclared dimension is `undeclared`, not a guess, and no model is consulted on this path |
| verified execution | `runGuarded` (`@memnox/sdk`), `POST /v1/actions/outcome` | Preconditions → action → postconditions → rollback. The outcome is the caller's testimony — the runtime cannot observe the outside world, so it records the claim and lets the log expose a decision that was never followed up. A failed rollback audits as critical |
| agent-facing tools | `memnox mcp` (`@memnox/cli`) | Memnox as an MCP server over stdio: `memnox_check_rules` and `memnox_status`. `McpServer` is message-in/message-out and owns no sockets, so the protocol is driven directly in tests |

## Dependency rules

```
discovery                                      (zero deps)
core ← policy-engine
core ← ledger
core ← local-gate ← tool-hook
core + policy-engine ← runtime
core ← sdk ← mcp-firewall
everything ← cli
```

- `core` and `policy-engine` have **zero** runtime dependencies — the trust-critical code is fully inspectable.
- Packages import each other only through their public `index.ts`.
- The decision path (`policy-engine`, `action-gateway`) makes no network calls, reads no clock as input to a verdict, and uses no randomness.

## Storage

One process, one machine, one audit chain. JSON and JSONL files under
`--data-dir` are the only implementation of every store port, and in-process
locks the only implementation of `LockService`. There is no shared-database path
and no multi-pod path: the open half is built so that neither is needed, and
serving more than one team means more than one runtime rather than a bigger one.

**Nothing is encrypted at rest.** Files are written owner-only (`0600`, in
`0700` directories) and that is the whole of the protection. A keyring this
runtime could not honestly promise to rotate would be worse than none, and key
management across a fleet is a cloud concern.

### Environment snapshots

Every command that scans the machine also keeps what it saw:
`snapshotOf(report, takenAt)` reduces a `DiscoveryReport` to names, counts and
fingerprints, and `NodeSnapshotStore` writes one file per scan under
`~/.memnox/snapshots`, oldest dropped past `SNAPSHOT_HISTORY_LIMIT`. A snapshot
carries no file contents, for the same reason a report does not.

This is what makes drift answerable offline: `memnox diff` compares this scan
against the last kept one, `memnox watch` keeps each cycle's scan as the next
baseline, and `memnox trace` dates a tool's arrival against the scan that first
held it rather than against a config file's mtime — a file edited for an
unrelated reason must not make a year-old tool look new.

### Bounded audit reads

`AuditQuery` carries a `limit`, and the JSONL adapter reads the file backwards
in chunks rather than loading a history and slicing it.

### Session taint store

Provenance classification is pure and lives in `core` (`classifySourceTaint`, `isRecordTainted`): source type first (`NEVER_TAINTED_SOURCE_TYPES` are ground truth, `ALWAYS_TAINTED_SOURCE_TYPES` are third-party free text), then the actor (GitHub `author_association`, Slack workspace membership), then a source-authority threshold. Actor facts are resolved by the ingestion path and passed in — the classifier performs no lookups and takes no dependencies.

Accumulated session taint lives behind the `SessionTaintStore` port: `read` returns the session's taint plus an `available` flag, `merge` folds new taint in monotonically. `InMemorySessionTaintStore` (core) is the only implementation: one process, one machine, nothing shared, and nothing survives a restart. A corrupt payload reports **tainted**, never clean.

**Taint is recorded, not enforced.** A tainted session is framed and stored, and `TAINT_NO_OVERRIDE_ACTIONS` still names the non-overridable class, but no shipped code turns taint into an escalation. Restoring that is a rule in the policy engine or a deployment's own `ActionAdvisor`.

### Retention

`AuditLog.pruneBefore(cutoff)` drops events past a horizon; `--audit-retention-days` schedules it hourly behind the `LockService`. The JSONL log rewrites into a sibling file and renames.

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
| Local rules unreadable, in a report | reported, never assumed | `memnox readiness` and `memnox watch` say the rule set would not load rather than reporting zero coverage — a broken rule set is not an empty one |
| Approval notifier failure | never affects the decision | Notification is best-effort; the audit log is the record |
