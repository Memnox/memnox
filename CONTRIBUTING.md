# Contributing to Memnox Runtime

Thanks for helping build the execution trust layer for AI agents.

## Setup

```bash
npm install
npm test              # vitest, runs against source — no build needed
npm run test:coverage # same, with a coverage report
npm run build         # builds every package with tsup
npm run format        # prettier
```

Node 20+ is required.

## Repository layout

```
packages/
  core/           # domain types, constants, store + advisor ports — zero dependencies
  policy-engine/  # deterministic evaluation + risk classification
  memory/         # team decisions as machine-checkable constraints
  risk/           # behavioral, trust, and dependency advisors
  content-shield/ # secret + PII scanning of written content
  code-graph/     # file-level import graph and blast radius
  runtime/        # gateway pipeline, HTTP server with RBAC, local stores, reporting
  postgres/       # Postgres adapters for the storage ports
  redis/          # Redis adapters for locks and session taint
  sdk/            # TypeScript client
  mcp-firewall/   # transparent MCP proxy
  intelligence/   # optional BYOK LLM layer — drafts and explains, never decides
  cli/            # memnox command (incl. editor hooks + protect)
  trust-bench/    # public governance benchmark
sdks/
  python/, go/    # thin dependency-free clients
examples/
  policies/       # ready-to-use policy files
```

Every package has its own README covering what it does, how it is laid out, and
what to touch when extending it. Read that one first.

Dependency direction is strict (see [ARCHITECTURE.md](ARCHITECTURE.md) for the full graph): `core` depends on nothing; `policy-engine` only on `core`; everything else composes those. Never import from another package's internals — only from its `index.ts`.

**Extending the gateway:** new escalation logic is an `ActionAdvisor` (see `@memnox/memory` and `@memnox/risk` for examples). Advisors may only tighten a decision, must be deterministic, and their failure must mean "no escalation" — never a crash, never an allow-nothing.

## Ground rules

1. **The decision path stays deterministic.** No LLM calls, network requests, clocks-as-input, or randomness inside policy evaluation. If a feature needs intelligence, it belongs in a separate, optional layer that explains decisions — it never makes them.
2. **Fail closed.** When identity or state cannot be verified, block. Never guess in the agent's favor.
3. **No `any`.** Use `unknown` plus explicit narrowing. Public and private async methods declare their return types.
4. **No magic values.** Numbers and strings with meaning live in a `*.constants.ts` file or a module-level `const` above the class.
5. **Every catch block logs or rethrows.** Silent catches are only acceptable for expected first-run conditions (e.g. a data file that does not exist yet) and must say so in a one-line comment.
6. **Comments are one line and explain WHY, not WHAT.** If code needs a paragraph to explain, restructure the code.
7. **Every behavior change ships with a test.** Tests live in `packages/<name>/test` and run against source via the vitest aliases.
8. **Audit everything.** Any new path through the gateway must append exactly one audit event.
9. **Take your dependencies as arguments.** Nothing reaches for `console`, the clock, the network, or `process.*` in the middle of its logic. That is what keeps the code testable — see below.
10. **No dead code.** `npm run deadcode` (knip) fails CI on an unused export. Delete it; git remembers.

## Testing without processes or sockets

The two places that used to be untestable were untestable for the same reason:
ambient IO. Both were fixed structurally, and both patterns are the model to
follow.

**CLI commands** take a `CliContext` carrying the output port and a client
factory. `runCli` in `packages/cli/test/cli-harness.ts` drives the real command
tree against a recording output and a stubbed transport:

```ts
const runtime = new FakeRuntime().on('POST', '/v1/actions/check', decision);
const { out } = await runCli(['check', '--token', 't', '--action', 'x'], runtime);
```

**The MCP firewall** splits routing (`FirewallSession`, over a `FirewallChannel`)
from process plumbing (`McpFirewall`, which owns the child process and stdio).
Tests drive the session directly — no `spawn`, no stdin.

**HTTP** is stubbed by passing `fetch` to `MemnoxClient`, so tests exercise the
real client code rather than a hand-written double of it.

If something is hard to test, that is usually the design telling you a dependency
is hidden. Pass it in rather than mocking a module.

## Naming

| Thing | Convention | Example |
|-------|-----------|---------|
| Files | kebab-case | `action-gateway.ts`, `jsonl-audit-log.ts` |
| Classes | PascalCase | `PolicyEngine`, `ActionGateway` |
| Methods | camelCase, verb-first | `authorize()`, `resolveApproval()` |
| Constants | SCREAMING_SNAKE | `DECISION_EFFECT`, `MAX_AUDIT_LIMIT` |
| Enum-like values | `as const` objects + derived union types | `DECISION_EFFECT`, `RISK_LEVEL` |

## Pull requests

- Keep PRs focused — one behavior change per PR.
- `npm run format && npm run typecheck && npm test && npm run deadcode` must all pass. CI enforces those four plus the build, a publish dry run, and the Python/Go SDK suites.
- Explain the failure mode your change prevents or the capability it adds, in two or three sentences.

## Security

Never open a public issue for a policy bypass, an audit-tampering finding, or
anything else that lets an action escape its gate. See [SECURITY.md](SECURITY.md).
