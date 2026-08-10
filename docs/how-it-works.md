# How a decision is made

> This page is the detailed one. If terms like *taint*, *fingerprint*, *capabilities*, or *blast radius* are new, read [concepts.md](concepts.md) first — it defines them in plain language.

Every call takes the same five steps, in the same order, with no LLM and no network anywhere in the path.

```
Identity → Policy → Advisors → Approval → Audit
```

1. **Identity.** The agent authenticates with its token, or optionally with an mTLS client certificate whose subject CN is the agent name (`--tls-cert`, `--tls-key`, `--tls-ca`). Unknown tokens are blocked and audited as critical, because identity fails closed. Suspended agents are blocked. An agent registered with `capabilities` (wildcard action patterns) is blocked for any action outside them, before policy even runs.

2. **Policy.** Every matching policy is collected and the most restrictive effect wins. When nothing matches, the configured default effect applies. That default is `allow`, so onboarding can start in monitor-first mode; run with `--default-effect block` for strict mode. See [writing policies](policies.md).

3. **Advisors.** These are deterministic escalators: recorded team decisions (`memnox memory add`), behavioral signals (`--behavior-guard`), low trust scores on risky actions (`--trust-guard`), unreported execution outcomes (`--verification-guard`), and provenance. Any of them can tighten a decision, and none of them can loosen it.

4. **Approval.** `require_approval` creates a pending approval bound to the exact action fingerprint, meaning agent plus action plus target plus environment, so a grant never applies to a different one of any of those. A human resolves it through the CLI, API, or SDK, and a Slack-compatible webhook can announce it (`--approval-webhook`).

5. **Audit.** Every request appends exactly one event to an append-only, hash-chained log recording who, what, decision, risk, matched policies, advisory signals, and session. Replay a session with `memnox replay <sessionId>`, and generate evidence with `memnox report`.

Risk levels run from `low` to `critical` and are classified by deterministic rules using action verbs and environment, never by a model. Every event also records `policyVersion`, the content hash of the rule set that decided it, so a decision can always be traced back to the exact policies in force.

## Approvals in practice

On the next attempt the gateway **claims the grant by fingerprint**, so the caller does not have to echo an approval id back. That is what lets the loop close for an editor hook or an MCP client that has nowhere to put one.

A grant is **single-use**. It is marked spent when it authorizes an action, so approving "write this file" authorizes that write rather than every write of it until the TTL runs out.

```bash
memnox approvals                 # what is waiting
memnox approve <id>              # grant it; --by defaults to $USER
memnox deny <id>
memnox approvals status <id>     # pending · granted 1/2 (dana) · approved
```

The agent then simply retries the same action. `--approval <id>` still works for callers that happen to have the id.

Admins can break-glass a pending approval with `memnox approvals override <id> --reason <text>`. The override requires a reason and is audited as critical. Irreversible actions such as `project.delete` and `database.drop` are the exception: break-glass is refused with 403 and audited.

A grant does **not** override an agent's declared `capabilities`, a suspended agent, or a non-overridable taint block. Each of those refuses the action and leaves the grant unspent.

`GET /v1/approvals/:id` is the only route an agent token may read. It returns the approval that agent raised, and 403s on anyone else's.

## Blast radius

A policy matches the path an action names, and that is not enough on its own. An agent editing `src/utils/money.ts` is editing payment code if `payment/checkout.ts` imports it. Build the import graph, then protect what matters:

```bash
memnox graph build                       # writes .memnox/code-graph.json
memnox graph explain src/utils/money.ts  # what a change here reaches
memnox serve --code-graph .memnox/code-graph.json --protected-path "*payment/*"
```

This is escalation-only and silent when uncertain, so an unresolvable target or an ambiguous path raises nothing rather than blaming the wrong file.

### Deeper code understanding, optionally

The built-in graph reads imports in a handful of languages. [Graphify](https://github.com/Graphify-Labs/graphify) parses 36 of them with tree-sitter and adds `calls` and `inherits` edges:

```bash
memnox graphify install   # uv / pipx / pip3
memnox graphify build     # AST only, so no LLM, no network, no API key
memnox setup              # picks it up automatically
```

Only `EXTRACTED` (AST) edges cross into the decision path. `INFERRED` ones are counted and discarded, because a model-derived edge must never influence a verdict. Graphify is never installed as a side effect, since running the install command is the consent.

Graphify is dual-licensed Apache-2.0 and MIT (© 2026 Safi Shamsi), makes no network calls during analysis, and parses rather than executes source. It stays an **optional** peer, because Memnox reads the JSON it writes and never links against it.

## Verified execution

A decision proves an action was *allowed*, and it does not prove the action worked. `guardVerified` closes that gap:

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

Postconditions that fail trigger the rollback, and the result is reported to `POST /v1/actions/outcome`, which audits it. A rollback that *also* fails is audited as critical, because that is the case where nobody knows what state the system is in.

## Provenance and prompt-injection defense

A caller reports where an agent's context came from through `taint` on `/v1/actions/check`. Classification is deterministic and actor-aware rather than only source-type-aware. `github_file`, `github_symbol`, `github_line_chunk`, and `extracted_decision` are ground truth and never tainted. A GitHub issue or comment from an `OWNER`, `MEMBER`, or `COLLABORATOR` is trusted, while the same issue from `NONE` is not. A Slack message is trusted only from a workspace member, and everything else falls back to a source-authority threshold. `_enriched` derivatives inherit their base classification, so an LLM rewrite cannot launder taint.

Taint attaches to the **session** rather than to strings, and merges monotonically, so once tainted a session stays tainted for the store's TTL. Privileged actions from a tainted session need a human, covering `file.write`, `shell.execute`, `deploy.*`, `database.*`, `mcp.*`, `data.export`, and `*.delete`. `project.delete` and `database.drop` are non-overridable: they are blocked outright and no approval, routine or break-glass, lifts the block.

Provenance is fail-closed, which is the one exception to "advisor failure means no escalation". If the session taint store cannot be read, the session is treated as tainted rather than assumed clean.

## Dependency governance

`serve --dependency-guard` governs `dependency.add`, covering known-vulnerable versions from the shield's curated offline table, plus licenses the organization cannot accept. License lookup defaults to an offline table, and `--dependency-license-lookup` opts into the npm registry. An unknown license or an unreachable registry raises nothing, because a lookup failure can never cause a wrongful block.

## Platform API

Beyond `/v1/actions/check`, the runtime exposes the named verbs other systems integrate against:

| Endpoint | Answers |
|---|---|
| `POST /v1/decision` | the full verdict, to inspect |
| `POST /v1/authorize` | 200 or 403, for callers that just want a yes or no |
| `POST /v1/context` | what governs this, before doing it: constraints plus the security baseline |
| `POST /v1/evaluate-risk` | what *would* happen. Audits nothing and creates no approval |
| `POST /v1/actions/outcome` | what actually happened after an allowed action |
| `GET /v1/policies` · `POST /v1/policies/validate` · `POST /v1/policies/reload` | inspect and reload the rule set |
| `POST /v1/memory/search` | search recorded decisions |
| `GET /v1/approvals/:id` | poll one approval, as the agent that raised it or as an admin |
| `GET /v1/agents/:id` · `POST /v1/agents/:id/rotate` | one agent's trust score, and issuing a new credential |

From the SDK, the same surface reads as predicates:

```ts
const api = new RuntimeApi(memnox);
if (await api.canDeploy({ environment: 'production' })) await deploy();
```

## Next

- [Writing policies](policies.md) covers the rules that feed step 2.
- [Deployment](deployment.md) covers running this for a team.
- [ARCHITECTURE.md](../ARCHITECTURE.md) maps each layer onto the code.
