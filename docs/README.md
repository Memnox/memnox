# Memnox documentation

Start here, then go where you need.

| If you want to… | Read |
|---|---|
| **Understand the words the rest of these docs use** | [concepts.md](concepts.md) |
| Get from nothing to a governed agent | [getting-started.md](getting-started.md) |
| Govern an MCP client, an SDK caller, or an agent framework | [governing-agents.md](governing-agents.md) |
| Write or tune the rules | [policies.md](policies.md) |
| Understand how a decision is reached | [how-it-works.md](how-it-works.md) |
| Run it for a team, or in containers | [deployment.md](deployment.md) |
| Run more than one runtime | [deploying-many.md](deploying-many.md) |
| Connect a runtime to a control plane | [connecting-a-control-plane.md](connecting-a-control-plane.md) |
| Fix something that is not working | [troubleshooting.md](troubleshooting.md) |
| Understand what Memnox is and why | [the root README](../README.md) |
| Understand how it works inside | [ARCHITECTURE.md](../ARCHITECTURE.md) |
| Change the code | [CONTRIBUTING.md](../CONTRIBUTING.md) |
| Report a bypass or a tampering finding | [SECURITY.md](../SECURITY.md) |

Every package also has its own README covering what it does and what to touch
when extending it — [`core`](../packages/core), [`policy-engine`](../packages/policy-engine),
[`runtime`](../packages/runtime), [`org-graph`](../packages/org-graph),
[`cli`](../packages/cli), and the rest.

## The one-paragraph version

Memnox sits between an AI agent and your systems and makes a deterministic
decision — **allow, block, or require human approval** — before anything runs.
The rules are YAML you commit. There is no LLM in the decision path: same input,
same decision, every time. It runs entirely on your machine, with no account and
no network call.

It is a **gate, not a worker**. It answers *"is this allowed, and who authorizes
it?"* — it never does the work itself.
