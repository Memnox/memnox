# Memnox Runtime

**The execution trust layer for AI agents.**

Every AI action becomes an event that Memnox can **understand, evaluate, authorize, and prove**. Memnox sits between AI agents (Claude Code, Cursor, OpenAI Agents, MCP clients, custom agents) and your systems, and makes a deterministic decision — allow, block, or require human approval — before anything executes.

```
AI Agent  ──▶  Memnox Runtime  ──▶  Your Systems
                    │
        Identity → Policy → Decision → Audit
```

There is **no LLM in the decision path**. Decisions come from a deterministic policy engine: same input, same decision, every time. That is the whole point — security decisions need guarantees, not probabilities.

**Memnox understands code; it never writes or reviews code.** It reads your repository to know what a change reaches, reads a diff to catch a secret, and reads a tool call to decide on it. It does not generate, edit, or commit anything, does not review pull requests, and runs no sandbox. Governing an agent and being an agent do not belong in the same trust boundary.

It is a **gate, not a reviewer**: it answers *"does this violate a rule?"*, never *"is this good code?"*

## Quick start

```bash
npm install
npm test

# 1. Create a starter policy file
npx memnox init

# 2. Start the runtime
npx memnox serve --policies memnox.policies.yaml

# 3. Register an agent (prints a token, shown once)
npx memnox agents register --name claude-code --kind claude-code

# 4. Ask for a decision
npx memnox check --token mnx_... --action database.delete --target users --env production
# Decision : BLOCK
# Reason   : No AI-initiated destructive database operations in production.
```

Or from code:

```ts
import { MemnoxClient } from '@memnox/sdk';

const memnox = new MemnoxClient({ baseUrl: 'http://127.0.0.1:7466', token: agentToken });

// Inspect the decision yourself…
const decision = await memnox.check({ action: 'deploy.service', environment: 'production' });

// …or wrap the dangerous work: it only runs if the runtime allows it.
await memnox.guard({ action: 'code.modify', target: 'payment/checkout.ts' }, async () => {
  await applyChanges();
});
```

## Protect real agents in one command

```bash
memnox protect                      # detects Claude Code and Cursor, installs both
memnox protect claude-code          # or name one explicitly
memnox protect cursor
export MEMNOX_AGENT_TOKEN=mnx_...   # from "memnox agents register"

# Any MCP server: wrap it with the firewall — tools/call is gated, denied tools are hidden
MEMNOX_AGENT_TOKEN=mnx_... memnox-mcp-firewall --name github -- npx -y @modelcontextprotocol/server-github
```

| Surface | How it is governed |
|---|---|
| **Claude Code** | `PreToolUse` hook; exit 2 denies the tool call |
| **Cursor** | Agent hooks (`preToolUse`, `beforeShellExecution`, `beforeMCPExecution`, `afterFileEdit`) — Memnox's three effects map exactly onto Cursor's `allow` / `deny` / `ask` |
| **Any MCP client** (Windsurf, Zed, Codex, …) | `@memnox/mcp-firewall` proxies the server; no per-client work |
| **OpenAI Agents SDK, LangGraph, CrewAI, custom loops** | `governTool` / `governTools` from the SDK wrap any function-calling tool registry |

```ts
import { MemnoxClient, governTools } from '@memnox/sdk';

const tools = governTools(memnox, { readFile, writeFile, runShell }, {
  sessionId: runId,
  environment: 'production',
});
// Same signatures, same framework wiring — each call is now decided before it runs.
```

## Packages

| Package | Purpose |
|---------|---------|
| [`@memnox/core`](packages/core) | Domain types, decision constants, store ports. Zero dependencies. |
| [`@memnox/policy-engine`](packages/policy-engine) | Deterministic policy evaluation and risk classification. Zero dependencies. |
| [`@memnox/memory`](packages/memory) | Organizational decision memory — team decisions become machine-checkable constraints, with keyword and optional hybrid semantic search. |
| [`@memnox/risk`](packages/risk) | Deterministic behavioral signals: novel destructive actions, bursts, boundary probing. |
| [`@memnox/content-shield`](packages/content-shield) | Offline secret/PII/vulnerable-package scanning of written content and git diffs — path-routed rules, versioned ruleset. |
| [`@memnox/code-graph`](packages/code-graph) | File-level import graph and blast radius — what a code change can actually reach. |
| [`@memnox/runtime`](packages/runtime) | The gateway: identity → policy → advisors → approval → audit, HTTP API with RBAC, local stores, compliance reports. |
| [`@memnox/sdk`](packages/sdk) | TypeScript client (`check`, `guard`, approvals, audit, memory, reports). |
| [`@memnox/mcp-firewall`](packages/mcp-firewall) | Transparent MCP proxy — every `tools/call` goes through the runtime. |
| [`@memnox/intelligence`](packages/intelligence) | Optional BYOK layer (Anthropic/OpenAI): draft policies from plain language, explain decisions, classify intent, embed decisions. Never decides. |
| [`@memnox/postgres`](packages/postgres) | Postgres adapters for the storage ports — shared state, indexed queries, batched retention. |
| [`@memnox/redis`](packages/redis) | Redis adapter for the `LockService` port — one rate-limit budget and one retention sweeper across pods. |
| [`@memnox/cli`](packages/cli) | `init · serve · validate · check · audit · agents · approvals · memory · replay · report · insights · draft · hook · protect · ci · explain · graph · policy · intent` |
| [`sdks/python`](sdks/python), [`sdks/go`](sdks/go) | Thin dependency-free clients for Python and Go. |

See [ARCHITECTURE.md](ARCHITECTURE.md) for how each layer of the product vision maps to code.

## Policies

Policies are plain YAML — reviewable, diffable, and enforced deterministically. All match fields take wildcard patterns (`*` matches anything); omitted fields match everything. When several policies match, the most restrictive effect wins (`block` > `require_approval` > `allow`).

```yaml
version: 1
policies:
  - name: production-database-protection
    match:
      actions: ["database.delete", "database.drop"]
      environments: ["production"]
    decision:
      effect: block
      reason: No AI-initiated destructive database operations in production.

  - name: payment-code-approval
    match:
      actions: ["code.modify"]
      targets: ["payment/*"]
    decision:
      effect: require_approval
      approvers: ["security-team"]
```

A policy can also demand a **quorum** and apply only inside a **time window**:

```yaml
  - name: production-deploy-two-person
    match:
      actions: ["deploy.service"]
      environments: ["production"]
      # Weeknights and weekends only — business hours are unrestricted.
      windows:
        - { days: [1,2,3,4,5], startHour: 17, endHour: 9 }
        - { days: [0,6], startHour: 0, endHour: 24 }
    decision:
      effect: require_approval
      approvers: ["eng-lead", "security"]
      minApprovals: 2
```

Grants accumulate until the quorum is met, one person counts once, and a single denial ends it.

Time windows do not break determinism: the instant is passed *into* evaluation rather than read
from the clock inside the engine, so replaying an audit event with its recorded timestamp
reproduces the same verdict.

See [examples/policies/baseline.yaml](examples/policies/baseline.yaml) for a fuller starting point.

## How a decision is made

1. **Identity** — the agent authenticates with its token (or, opt-in, an mTLS client certificate whose subject CN is the agent name — `--tls-cert/--tls-key/--tls-ca`). Unknown tokens are blocked and audited as critical (fail closed). Suspended agents are blocked. An agent registered with `capabilities` (wildcard action patterns) is blocked for any action outside them, before policy runs.
2. **Policy** — every matching policy is collected; the most restrictive effect wins. No matches → the configured default effect (`allow` by default for monitor-first onboarding; run with `--default-effect block` for strict mode).
3. **Advisors** — deterministic escalators: recorded team decisions (`memnox memory add`), behavioral signals (`--behavior-guard`), low trust scores on risky actions (`--trust-guard`), and provenance (taint) can tighten a decision, never loosen it.
4. **Approval** — `require_approval` creates a pending approval bound to the exact action fingerprint (agent + action + target + environment), so a granted approval cannot be replayed for a different action. A human resolves it via CLI, API, or SDK; a Slack-compatible webhook can announce it (`--approval-webhook`). Admins can break-glass a pending approval (`memnox approvals override <id> --reason <text>`) — the override requires a reason and is audited as critical. Irreversible actions (`project.delete`, `database.drop`) are the exception: break-glass is refused with 403 and audited.
5. **Audit** — every request appends exactly one event to an append-only, hash-chained audit log: who, what, decision, risk, matched policies, advisory signals, session. Replay a session with `memnox replay <sessionId>`; generate governance evidence with `memnox report`.

Risk levels (`low` → `critical`) are classified by deterministic rules (action verbs + environment), never by a model.

Every event also records `policyVersion`, the content hash of the rule set that decided it, so a decision can always be traced back to the exact policies in force.

### Blast radius

A policy matches the path an action names. That is not enough: an agent editing `src/utils/money.ts` is editing payment code if `payment/checkout.ts` imports it. Build the import graph, then protect what matters:

```bash
memnox graph build                       # writes .memnox/code-graph.json
memnox graph explain src/utils/money.ts  # what a change here reaches
memnox serve --code-graph .memnox/code-graph.json --protected-path "*payment/*"
```

Escalation-only and silent when uncertain — an unresolvable target or an ambiguous path raises nothing rather than blaming the wrong file.

### Verified execution

A decision proves an action was *allowed*. It does not prove it worked. `runGuarded` closes that gap:

```ts
const outcome = await memnox.guardVerified(
  { action: 'code.modify', target: 'src/payment/checkout.ts' },
  {
    preconditions: [{ description: 'branch is clean', check: () => isClean() }],
    execute: () => applyPatch(),
    postconditions: [{ description: 'tests pass', check: () => runTests() }],
    rollback: { description: 'revert commit', execute: () => revert() },
  },
);
// outcome.status: succeeded | precondition_failed | execution_failed | postcondition_failed
```

Postconditions that fail trigger the rollback, and the result is reported to `POST /v1/actions/outcome`, which audits it. A rollback that *also* fails is audited as critical — that is the case where nobody knows what state the system is in.

### Policy lifecycle

```bash
memnox policy packs                    # production-safety, payments, auth-and-secrets, data-privacy, supply-chain
memnox policy install production-safety
memnox policy version                  # content hash of the current rule set
memnox policy simulate -f candidate.yaml --from-audit   # what would change, against real history
```

`simulate` replays your actual audit history through a candidate rule set and reports every decision that would differ — and warns loudly if any action becomes *more* permissive.

### Platform API

Beyond `/v1/actions/check`, the runtime exposes the named verbs other systems integrate against:

| Endpoint | Answers |
|---|---|
| `POST /v1/decision` | the full verdict, to inspect |
| `POST /v1/authorize` | 200 or 403 — for callers that just want a yes/no |
| `POST /v1/evaluate-risk` | what *would* happen. Audits nothing, creates no approval |
| `POST /v1/actions/outcome` | what actually happened after an allowed action |
| `GET /v1/policies` · `POST /v1/policies/validate` · `POST /v1/policies/reload` | inspect and reload the rule set |
| `POST /v1/memory/search` | search recorded decisions |
| `GET /v1/approvals/:id` | poll one approval — the agent that raised it, or an admin |
| `GET /v1/agents/:id` · `POST /v1/agents/:id/rotate` | one agent's trust score; issue a new credential |

An agent handed `require_approval` gets an `approvalId` back, and polls it until a
human decides:

```bash
memnox approvals status <id>     # pending · granted 1/2 (dana) · approved
```

`GET /v1/approvals/:id` is the only route an agent token may read: it returns the
approval that agent raised, and 403s on anyone else's.

From the SDK, the same surface reads as predicates:

```ts
const api = new RuntimeApi(memnox);
if (await api.canDeploy({ environment: 'production' })) await deploy();
```

Policies stay file-sourced on purpose — a rule set mutable over HTTP is one nobody can review in a diff. `reload` re-reads the file; authoring belongs to your repository.

### Dependency governance

`serve --dependency-guard` governs `dependency.add`: known-vulnerable versions (from the shield's curated table, offline) and licenses the organization cannot accept. License lookup defaults to an offline table; `--dependency-license-lookup` opts into the npm registry. An unknown license or an unreachable registry raises nothing — a lookup failure can never cause a wrongful block.

### Provenance (prompt-injection defense)

A caller reports where an agent's context came from (`taint` on `/v1/actions/check`). Classification is deterministic and actor-aware, not just source-type-aware: `github_file`/`github_symbol`/`github_line_chunk`/`extracted_decision` are ground truth and never tainted; a GitHub issue or comment from an `OWNER`/`MEMBER`/`COLLABORATOR` is trusted while the same issue from `NONE` is not; a Slack message is trusted only from a workspace member; everything else falls back to a source-authority threshold. `_enriched` derivatives inherit their base classification, so an LLM rewrite cannot launder taint.

Taint attaches to the **session**, not to strings, and merges monotonically — once tainted, a session stays tainted for the store's TTL. Privileged actions (`file.write`, `shell.execute`, `deploy.*`, `database.*`, `mcp.*`, `data.export`, `*.delete`) from a tainted session need a human. `project.delete` and `database.drop` are non-overridable: they are blocked outright and no approval — routine or break-glass — lifts the block.

Provenance is fail-closed, the one exception to "advisor failure = no escalation": if the session taint store cannot be read, the session is treated as tainted rather than assumed clean.

## Solo, team, enterprise

The same binary serves all three; the difference is configuration, not a different product.

| | Solo | Team | Enterprise |
|---|---|---|---|
| **Setup** | `npx memnox init && npx memnox serve` | `--database-url` + `--redis-url` | above + `memnox-cloud` |
| **Account required** | none | none | SSO via your IdP |
| **Storage** | JSON/JSONL files | shared Postgres | Postgres + retention policy |
| **Approvals** | CLI | Slack buttons, RBAC API keys | Slack + OIDC identities |
| **Audit** | hash-chained JSONL | shared, verifiable | + CSV/compliance export, retention |
| **Multi-org** | — | — | `orgId` on every record |

Solo genuinely means zero infrastructure: no account, no API key, no network call. A developer can protect their editor in two commands and never talk to a server that isn't on their laptop. Everything above is additive — nothing about the solo path changes when a team adopts it.

## Running it at scale

The zero-infrastructure defaults (file stores, per-process rate limits, keep-everything audit) are for one process. Four flags turn the same binary into a horizontally scaled deployment:

```bash
memnox serve \
  --database-url postgres://…      # or MEMNOX_DATABASE_URL — shared identity, approvals, audit
  --redis-url redis://…            # or MEMNOX_REDIS_URL — one rate-limit budget across all pods
  --audit-retention-days 365 \     # hourly pruning sweep, batched, lock-guarded (0 = keep everything)
  --rate-limit 600
```

- **Rate limiting.** Without `--redis-url` each pod counts on its own, so N pods means N× the configured limit. With it, the fixed-window counter lives in Redis and every pod shares one budget. If the URL is set but Redis is unreachable, startup fails rather than silently degrading.
- **Session taint.** `--redis-url` also moves the session taint store into Redis (lock-guarded read-merge-write, 7-day TTL), so a session that saw untrusted content stays tainted on every pod. Without it the store is per-process. It is never reconstructed from the audit log.
- **Audit retention.** `--audit-retention-days` prunes older events on an hourly sweep. The Postgres delete is batched so it never holds a long table lock, and one distributed lock keeps a single pod sweeping at a time. Native table partitioning is not implemented — see [ARCHITECTURE.md](ARCHITECTURE.md).
- **Bounded reads.** Advisors ask for a fixed recent window instead of an agent's whole history, and the bound is pushed into SQL (`ORDER BY occurred_at DESC LIMIT n`) rather than applied after the fact.
- **Multi-tenancy.** Agents, decisions, approvals, and audit events carry an optional `orgId` (nullable `org_id` column, indexed). Register with `{"orgId": "acme"}` and every event that agent produces is stamped and filterable via `GET /v1/audit?org=acme`. Leaving it unset is the existing single-tenant behavior.

### Audit verification

Each event stores `prevHash` and `hash = sha256(canonical event + prevHash)`, computed at append time. Editing or deleting a record breaks the chain:

```bash
memnox audit verify
# Audit chain intact — 128401 events verified.
# …or: Audit chain BROKEN at event #91 (0f3a…): content-mismatch
```

`GET /v1/audit/verify` returns the same result as JSON. This is tamper *evidence*, not tamper proofing — it detects edits to a log you already control, it does not stop an operator with database access from rewriting the whole chain.

### Metrics

`GET /v1/metrics` serves Prometheus text with counters this pod already tracks: actions by effect and risk level, approvals pending/resolved, rate-limit rejections, and audit append failures. Counters are per-process — summing across pods is the scrape layer's job.

## Design principles

- **Deterministic core.** No LLM, no network calls, no randomness in the decision path. LLMs belong in a future intelligence layer (natural-language policy authoring, memory extraction, explanations) — never in enforcement.
- **Fail closed.** Unknown identity, unreadable state, or ambiguous input results in a block, not a guess.
- **Everything auditable.** A decision that cannot be proven afterwards did not happen.
- **Small, inspectable pieces.** The runtime governs what AI does in your environment — you should be able to read every line of it.
- **Ports over lock-in.** Storage is behind small interfaces (`IdentityStore`, `AuditLog`, `ApprovalStore`); the local adapters are plain JSON/JSONL files, and any backend can implement them.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: `npm install`, `npm test`, keep the decision path deterministic, no `any`, no magic values, no comment essays.

## License

[Apache-2.0](LICENSE)
