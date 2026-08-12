<div align="center">

<img src="assets/logo.png" alt="Memnox" width="120" height="120">

[Documentation](docs/) • [Quickstart](docs/getting-started.md) • [Concepts](docs/concepts.md) • [Changelog](CHANGELOG.md)

<!-- Static badges render before the first publish. After publishing, swap the first two for:
     [![CI](https://github.com/memnox/memnox-runtime/actions/workflows/ci.yml/badge.svg)](https://github.com/memnox/memnox-runtime/actions/workflows/ci.yml)
     [![npm](https://img.shields.io/npm/v/memnox?label=memnox)](https://www.npmjs.com/package/memnox) -->

[![memnox](https://img.shields.io/badge/memnox-v0.1.0-orange)](packages/cli)
[![@memnox/sdk](https://img.shields.io/badge/%40memnox%2Fsdk-v0.1.0-orange)](packages/sdk)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)

</div>

# Memnox

Memnox gives your AI agents a deterministic policy gate, human approvals, tamper-evident audit, secret and PII scanning, and prompt-injection defense — so you can let agents act on real systems without hoping they behave.

This is the Memnox runtime monorepo. It contains:

- [`memnox`](packages/cli): the CLI — set up, observe, tune, enforce, and approve from your shell
- [`@memnox/sdk`](packages/sdk): TypeScript SDK, plus [Python, Go, Rust, Java, and Swift](#client-sdks) clients
- [`@memnox/runtime`](packages/runtime): the decision gateway and HTTP API you run locally or for a team
- [`@memnox/organization`](packages/organization): the open client for asking an organization whether an action should happen, and who authorizes it
- [`@memnox/mcp-firewall`](packages/mcp-firewall): a transparent MCP proxy, so every `tools/call` is gated
- **Editor hooks** for Claude Code and Cursor, and adapters for OpenAI Agents, LangChain, and [more](docs/governing-agents.md)

## What it does

AI agents now write files, run shell commands, and call APIs on your behalf. Memnox sits between those agents and your systems, and decides on every action before it runs: **allow, block, or ask a human first.**

```
AI Agent  ──▶  Memnox Runtime  ──▶  Your Systems
                    │
        Identity → Policy → Decision → Audit
```

Three things make that decision worth trusting.

**It is deterministic.** There is no LLM in the decision path, so the same input always produces the same decision. Security decisions need guarantees rather than probabilities.

**It is a gate, not a reviewer.** It answers *"does this violate a rule?"* and never *"is this good code?"*. Memnox reads your repository, your diffs, and your tool calls, and it never generates, edits, or commits anything, never reviews pull requests, and runs no sandbox. Governing an agent and being an agent do not belong in the same trust boundary.

**It leaves proof.** Every decision appends one event to a hash-chained audit log, so you can replay any session and show exactly what was allowed, what was stopped, and under which rule.

## Quickstart

```bash
npx memnox setup
```

That one command scaffolds a policy file from what it detects in your repository, registers a local agent, installs hooks for whichever editors you have, registers the MCP server (Model Context Protocol — how AI assistants connect to external tools) so your agent can ask about rules before it writes, and starts the runtime. **Restart your editor and it is governed.**

New to this? [Concepts and vocabulary](docs/concepts.md) explains agents, actions, hooks, and the rest in five minutes.

```
Wrote starter policies to memnox.policies.yaml (project: acme-checkout)
Detected: payments, database migrations, CI/CD, infrastructure as code
Packs: production-safety, terminal-safety, payments, money-movement, data-privacy, supply-chain
```

The first run **observes without blocking**, because a rule you have not read yet should not wedge your editor on minute one. Watch what it would have done:

```bash
memnox status   # is it on, what is in force, what would it have stopped
memnox audit    # every decision, newest first
```

```
Runtime   : http://127.0.0.1:7466
Policies  : 10 (version e852ac2d63d0)
Credential: stored (config)
Decisions : 214 recent
Waiting   : 1 approval(s)
Observed  : 9 would have been stopped if enforcing
```

That last line is the number to watch, because it tells you whether enforcing is safe yet. When the decisions look right, re-run as `memnox setup --enforce`.

Everything runs on your machine. No account, no API key, and no network call.

**→ [Full walkthrough: observe, tune, enforce, and the daily approval loop](docs/getting-started.md)**

## Beyond one machine

The runtime governs the agents on your laptop or in your cluster, free and Apache-2.0, forever. It answers one question completely: **does this action break a rule?**

There is a second question it cannot answer, because the answer is not in your repository. *Nothing forbids this refund, and it is still somebody's to authorize.* Who owns this system. What the company already decided last quarter. How much of the evidence this particular agent is entitled to see. Those are facts about an organization, gathered from systems you didn't write, and they are what **Memnox Cloud** holds. It is free for one person.

The two compose in one direction only: the runtime's refusal is final and the organization never widens it. The organization may only tighten an allow into an escalation — the case no policy file can express.

```ts
import { MemnoxOrganization, mayProceed } from '@memnox/organization';

const org = new MemnoxOrganization({ token: process.env.MEMNOX_GRANT!, workspace: 'acme' });

const answer = await org.evaluate({
  action: 'payment.refund',
  principal: 'sarah@acme.test',
  amount: 4500,
});

// answer.decision is allow · deny · ask · escalate · delegate · clarify,
// alongside the context this agent may use and the constraints it must respect.
if (mayProceed(answer)) await issueRefund();
```

That package is Apache-2.0 and deliberately thin: the protocol and nothing else, no tools, no execution, no copy of the organization. It never fails open — a call that cannot reach Memnox throws rather than returning a permissive default.

**→ [Connecting a runtime to a control plane](docs/connecting-a-control-plane.md)** · **→ [Running more than one runtime](docs/deploying-many.md)** · **→ [`@memnox/organization`](packages/organization)**

## Use it from code

```ts
import { MemnoxClient } from '@memnox/sdk';

const memnox = new MemnoxClient({ baseUrl: 'http://127.0.0.1:7466', token: agentToken });

// Inspect the decision yourself…
const decision = await memnox.check({ action: 'deploy.service', environment: 'production' });

// …or wrap the dangerous work, so it only runs if the runtime allows it.
await memnox.guard({ action: 'code.modify', target: 'payment/checkout.ts' }, async () => {
  await applyChanges();
});
```

Rules are plain YAML that you commit and review like any other code:

```yaml
- name: payment-code-approval
  match:
    actions: ["code.modify"]
    targets: ["payment/*"]
  decision:
    effect: require_approval
    approvers: ["security-team"]
```

**→ [Writing policies](docs/policies.md)**

## Documentation

| Guide | What it covers |
|---|---|
| [Concepts and vocabulary](docs/concepts.md) | New here? The mental model and every term the other guides assume |
| [Getting started](docs/getting-started.md) | From nothing to a governed editor, then observing, tuning, and enforcing |
| [Governing your agents](docs/governing-agents.md) | Claude Code, Cursor, MCP clients, and agent frameworks. How an agent asks what the rules are |
| [Writing policies](docs/policies.md) | YAML rules, quorum, time windows, argument matching, and multi-repo projects |
| [How a decision is made](docs/how-it-works.md) | The five-step pipeline, approvals, blast radius, provenance, and the platform API |
| [Deployment](docs/deployment.md) | Solo through enterprise, scaling flags, containers, audit verification, and metrics |
| [Running more than one](docs/deploying-many.md) | A runtime is one tenant; how several are deployed and reached together |
| [Connecting a control plane](docs/connecting-a-control-plane.md) | Reading across runtimes, mirroring the audit log off the box, setting enforcement without a restart |
| [Troubleshooting](docs/troubleshooting.md) | The failure modes people actually hit |
| [Architecture](ARCHITECTURE.md) | How each layer maps onto the code, and what the system deliberately does not do |

## Packages

This is a monorepo. Each package is one layer, and the two at the top have zero dependencies.

| Package | Purpose |
|---------|---------|
| [`@memnox/core`](packages/core) | Domain types, decision constants, and store ports. Zero dependencies. |
| [`@memnox/policy-engine`](packages/policy-engine) | Deterministic policy evaluation and risk classification. Zero dependencies. |
| [`@memnox/runtime`](packages/runtime) | The gateway, the HTTP API with RBAC, local stores, and compliance reports |
| [`@memnox/memory`](packages/memory) | Team decisions turned into machine-checkable constraints |
| [`@memnox/risk`](packages/risk) | Deterministic behavioral signals such as novel destructive actions and bursts |
| [`@memnox/content-shield`](packages/content-shield) | Offline secret, PII, and vulnerable-package scanning of content and diffs |
| [`@memnox/code-graph`](packages/code-graph) | Import graph and blast radius, meaning what a change can actually reach |
| [`@memnox/mcp-firewall`](packages/mcp-firewall) | Transparent MCP proxy, so every `tools/call` goes through the runtime |
| [`@memnox/local-gate`](packages/local-gate) | In-process gate, so a call's arguments and content never leave the machine |
| [`@memnox/intelligence`](packages/intelligence) | Optional BYOK layer that drafts and explains. It never decides. |
| [`@memnox/trust-bench`](packages/trust-bench) | Public benchmark for agent-governance runtimes |
| [`@memnox/postgres`](packages/postgres) · [`@memnox/redis`](packages/redis) | Adapters for shared storage and locks |
| [`@memnox/sdk`](packages/sdk) · [`memnox`](packages/cli) | TypeScript client, and the CLI with its 37 commands |

### Client SDKs

Ask the runtime for a decision from whatever your service is written in. Every client is dependency-free, covers the same surface, and runs its own suite in CI.

| Language | Package | Source |
|---|---|---|
| TypeScript | `@memnox/sdk` | [packages/sdk](packages/sdk) |
| Python | `memnox` | [sdks/python](sdks/python) |
| Go | `github.com/memnox/memnox-go` | [sdks/go](sdks/go) |
| Rust | `memnox` | [sdks/rust](sdks/rust) |
| Java | `ai.memnox:memnox` | [sdks/java](sdks/java) |
| Swift | `Memnox` | [sdks/swift](sdks/swift) |

## Contributing

Contributions are welcome, and the fastest way in is to run the test suite and read one package.

```bash
npm install
npm test           # vitest runs against source, so there is no build step
npm run build      # every package, through tsup
```

```
packages/          one package per layer
sdks/              client SDKs for python, go, rust, java, swift
docs/              guides
examples/          ready-to-use policy files and a governed agent
```

Before opening a pull request, these four must pass. CI enforces them plus the build, a publish dry run, and the five SDK suites:

```bash
npm run format && npm run typecheck && npm test && npm run deadcode
```

A few rules keep the codebase coherent: the decision path stays deterministic, no `any`, no magic values, and every behavior change ships with a test. New escalation logic is an `ActionAdvisor`, which may only tighten a decision and must never crash. [CONTRIBUTING.md](CONTRIBUTING.md) explains why each rule exists and shows how to test without processes or sockets.

## Design principles

**Deterministic core.** No LLM, no network calls, and no randomness in the decision path. Intelligence can draft and explain, and it never enforces.

**Fail closed.** Unknown identity, unreadable state, or ambiguous input produces a block rather than a guess.

**Everything auditable.** A decision that cannot be proven afterwards did not happen.

**Small, inspectable pieces.** This runtime governs what AI does in your environment, so you should be able to read every line of it.

**Ports over lock-in.** Storage sits behind small interfaces, the local adapters are plain JSON and JSONL files, and any backend can implement them.

## Support

- [Documentation](docs/) for guides, and [troubleshooting](docs/troubleshooting.md) when something breaks
- [Open an issue](https://github.com/memnox/memnox-runtime/issues) for bugs and feature requests
- `security@memnox.dev` for policy bypasses and audit-tampering findings. Never a public issue; see [SECURITY.md](SECURITY.md)

## License

[Apache-2.0](LICENSE)
