# Concepts and vocabulary

Read this once if you are new. The other guides assume the words on this page, and a few of them are ordinary English used in a narrow, specific sense here.

## The one thing to understand first

An AI assistant does not write files, run commands, or call APIs directly. It *asks* its host program to do it — "write this file", "run this command" — and the host carries it out. That request is the moment where something can step in and decide.

Memnox is what steps in. It answers one question, over and over: **may this particular action, by this particular agent, proceed?**

```
Your AI assistant                Memnox                 Your files, shell, APIs
       │                            │                            │
       ├── "write payment/fee.ts" ─▶│                            │
       │                            │  check the rules           │
       │◀── withhold / escalate / ──┤                            │
       │        allow               │                            │
       └── only if allowed ─────────┴───────────────────────────▶│
```

It never does the work itself. It decides, records the decision, and gets out of the way.

## The vocabulary of one decision

Every rule you write and every audit line you read is built from the same four fields. Learn these and the rest of the docs open up.

| Term | What it means | Examples |
|---|---|---|
| **agent** | *The AI tool being governed* — not a person. Claude Code, Cursor, an MCP server, your own script. Each has a registered identity and a token. | `local-editor`, `claude-code` |
| **action** | The kind of thing being attempted, as `noun.verb`. The caller supplies it; the MCP firewall and the SDK's tool wrappers derive it for you. | `file.write`, `shell.execute`, `deploy.service`, `dependency.add` |
| **target** | What the action is aimed at. Usually a path, sometimes a command, package, or service. | `payment/checkout.ts`, `rm -rf ./build`, `left-pad@1.0.0` |
| **environment** | Which world this is happening in, when the caller says. Lets one rule apply in production and not locally. | `production`, `staging` |

A policy matches on those fields and returns an **effect**. There are three, and when several policies match, the most restrictive one wins:

| Effect | What happens | Precedence |
|---|---|---|
| `withhold` | Refused, and the rule may name what to use instead. | strongest |
| `escalate` | Paused until a person answers. It is what keeps a governed system from being a wall. | |
| `allow` | Proceeds. | weakest |

That is the shorthand the rest of these docs use: **allow, withhold, or escalate**.

A `withhold` may carry an **alternative** — the action and resource the rule permits
instead. A refusal that names the permitted path gets taken, and a coding agent will
take it without being asked twice. A refusal that names nothing is an agent that
abandons the task and a developer who blames the tool.

Every decision also carries a **risk level** — `low`, `medium`, `high`, `critical` — classified deterministically from the action's verb and environment, never by a model.

## Two more fields, and why they are types rather than guesses

**Task and declared scope.** A session can say what it was asked for and what that
implies: these paths, this repository, this environment. A request that falls outside it
is `out_of_scope`, which is a *fact a rule matches on*, exactly like an environment.

```yaml
match:
  actions: ["filesystem.read"]
  targets: [".env"]
  scope: ["out_of_scope"]
decision:
  effect: withhold
  reason: This task declared no credential need.
  alternative:
    action: filesystem.read
    resource: .env.example
    note: .env.example is readable.
```

Scope is **compared, never judged**. The client declares the task; nothing infers it. An
undeclared dimension is `undeclared`, not a guess that the request was fine, so a client
that has never learned to declare a task is not silently refused. The ambiguous middle
escalates to a person rather than to a classifier — inferring intent would put a model
on the hot path, which the decision path forbids everywhere.

**Context trust.** What an agent read arrives as blocks, each carrying the trust of
whoever supplied it — `trusted`, `untrusted`, `unknown`. An untrusted block keeps its
evidence value and loses its instruction authority.

**Data cannot become authority because an agent read it.** That is a type, not a
detector: a detector can be wrong, but a type cannot be talked around. When the MCP
proxy hands back a tool result, it is untrusted whatever it says, and instruction-shaped
content in it is recorded and quoted rather than obeyed — and never removed, because
silently editing a payload is a bug the agent cannot see and you cannot audit.

## The pieces on your machine

`memnox setup` puts several things in place. They are easy to confuse because they all say "memnox".

| Piece | What it actually is | Lives |
|---|---|---|
| **the runtime** | A small HTTP server, running as a process on your machine. It holds the rules and makes every decision. If you close the terminal running it, it is gone and governance stops. | `127.0.0.1:7466` by default |
| **the CLI** | The `memnox` command. Mostly a client that talks to the runtime over HTTP. | your `PATH` |
| **the policy file** | Your rules, as YAML you commit to the repository. | `memnox.policies.yaml` |
| **the MCP server** | Lets the agent *ask* what the rules are, on its own, before it commits to an approach. | `~/.claude.json`, `~/.cursor/mcp.json` |
| **the MCP firewall** | A proxy that wraps some *other* MCP server, so its tool calls get gated too. | launched by your MCP client |
| **the stores** | The audit log, agents, and approvals — plain JSON and JSONL files. | `./.memnox/` in the project |

The last two are why **you must restart your agent** after setup: an MCP client reads its server config once, at launch.

### What MCP is

**MCP** is the Model Context Protocol — an open standard for connecting AI assistants to external tools and data. An **MCP server** exposes tools (read a GitHub issue, query a database); an **MCP client** is the AI app that calls them (Claude Code, Cursor, Windsurf, Zed).

Memnox shows up on both sides, which is the confusing part:

- **As an MCP server**, it gives your assistant tools to *ask about rules* (`memnox_check_rules`, `memnox_status`). Advisory.
- **As an MCP firewall**, it sits in front of *someone else's* MCP server and gates every `tools/call` going through it. Enforcing, and it **fails closed** — because a firewall that fails open is not a firewall.

## Words used in a narrow sense

| Term | Meaning here |
|---|---|
| **deterministic** | Same input always produces the same decision. No model, no network call, no clock, no randomness anywhere in the decision path. This is the central design claim — security decisions need guarantees, not probabilities. |
| **fail closed** | When something is broken or unknown, refuse. Applied to identity, to provenance, and to the MCP firewall when the runtime is unreachable. |
| **fail open** | When something is broken, allow. Applied only where a broken counter would stop every agent rather than protect anything — an unreachable rate limiter, for instance — and always said out loud. |
| **observe / advise / enforce** | The ramp, softest first. Observe records the real verdict without applying it; advise tells the caller and lets it through; enforce applies it. Observing first is strongly recommended. |
| **shadow effect** | What enforce *would* have said, computed and stored even when the mode did not apply it. It is why observing produces anything worth reading, and why a candidate rule can be simulated against real history. |
| **gate, not worker** | Memnox answers "is this allowed, and who authorizes it?" It never does the work itself: it does not generate, edit, or commit anything, and it does not read your code. |
| **guard / advisor** | An optional deterministic check that can *tighten* a decision — never loosen it. If one fails, the result is "no escalation", never a crash. |
| **session** | One continuous run of an agent. Ties related actions together so you can `memnox replay` them in order — and it is what taint sticks to. |
| **taint** | A marker meaning "this session has seen content from a source you do not control" — a GitHub issue from a stranger, a fetched web page. Privileged actions from a tainted session need a human. This is the prompt-injection defense: the concern is the assistant being *told* to do something by content it read. |
| **provenance** | Where the agent's context came from, which is what taint is computed from. |
| **audit chain** | The log of decisions, where each entry includes a hash of the previous one. Altering an old entry breaks every hash after it, so `memnox audit verify` can prove nothing was edited. |
| **fingerprint** | The identity of one exact action — agent + action + target + environment. Approvals are bound to it, so a grant cannot be reused for a different file. |
| **grant** | A resolved approval. **Single-use**: approving "write this file" authorizes that one write, not every write until it expires. |
| **quorum** | Requiring more than one approver (`minApprovals: 2`) — the two-person rule. |
| **break-glass** | An admin forcing through a pending approval (`memnox approvals override`). Requires a written reason and is permanently audited as critical. Some actions refuse it entirely. |
| **capabilities** | An optional allowlist of action patterns for one agent. Anything outside is refused before policy even runs. |
| **capability / lease** | Asked for by operation, never by secret: "refund create for this customer", not "the payments key". The broker exchanges the request for a lease scoped to one operation and a few minutes. Expiry belongs to the issuer, never to the agent's good behaviour. |
| **seam** | The place Memnox actually stands to see an action — an MCP proxy, a tool hook, a shell wrapper, a git credential helper. Every seam declares what it **cannot** see, because a governed agent with an unwatched side channel is worse than an ungoverned one. |
| **alternative** | What a withholding rule permits instead. Small field, most of the real work: it is the difference between an agent abandoning a task and finishing it under constraint. |
| **declared scope** | What a session said it was asked to touch. Compared, never judged — see above. |
| **state fact** | The company's current condition read as a policy input: a freeze, an open incident, a change window. Every one carries a mandatory expiry, because a freeze that outlives its incident is worse than no freeze — the next one gets ignored. |
| **containment** | Kill, quarantine or panic. Each records which machines it reached and **which it did not**: a killed agent on a sleeping laptop is not killed yet. |
| **autonomy level** | A named bundle of rules a person granted an agent: observe, suggest, act reversibly, act within bounds, act autonomously, hold delegated authority. Down is automatic on an incident; up needs a person and a met readiness checklist. A score would narrow permissions silently, which is unauditable. |
| **policy pack** | A prebuilt bundle of rules for a common concern — `production-safety`, `payments`. `memnox policy packs` lists them. |
| **project scope** | If a policy file sets `project:`, requests must name that project or the rules do not apply. A common cause of "my rule never matches". |
| **control plane** | An optional shared server several runtimes report to. Not needed for solo use. |

## Acronyms

| | |
|---|---|
| **MCP** | Model Context Protocol — see above |
| **PII** | Personally Identifiable Information — names, emails, card numbers. The `data-privacy` policy pack governs the actions that touch it. |
| **TTL** | Time To Live — how long something stays valid before expiring |
| **RBAC** | Role-Based Access Control — API keys carry a role that decides which routes they may call |
| **mTLS** | Mutual TLS — both sides present certificates, so the client is authenticated too. An optional alternative to token identity. |
| **BYOK** | Bring Your Own Key — the optional intelligence layer uses *your* LLM API key. It drafts, and that is all: it never decides, never explains a decision, and never infers intent. |
| **CN** | Common Name — the identity field in a TLS certificate |

## Where to go next

- [What can already act on this machine](discovering-your-machine.md) — before any of the below
- [Getting started](getting-started.md) — install, observe, tune, enforce
- [Writing policies](policies.md) — the YAML in detail
- [Learning from behaviour](learning-from-behaviour.md) — a week of work becomes rules
- [Operating](operating.md) — coverage, containment, census, readiness, evidence
- [How a decision is made](how-it-works.md) — the five-step pipeline
- [Troubleshooting](troubleshooting.md) — when something does not work
