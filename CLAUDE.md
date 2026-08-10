# Memnox Runtime — Code Conventions

Read before writing code. Every rule exists because of a real mistake in the predecessor codebase or a deliberate architectural decision.

## Architecture (DDD layers)

```
interface       packages/cli, packages/runtime/src/routes, packages/sdk, sdks/*
                transports; validate shapes, map outcomes to codes, nothing else

application     ActionGateway, ApprovalService, AgentRegistry, DecisionRegistry
                orchestration + invariants; owns the pipeline

domain          packages/core, policy-engine, memory, risk, content-shield, code-graph
                pure types, constants, deterministic logic; core + policy-engine have ZERO deps

infrastructure  packages/runtime/src/stores, codecs, notifiers, @memnox/postgres, @memnox/redis
                adapters behind ports defined in core
```

### The application layer is split by responsibility

`ActionGateway` owns the decision pipeline and nothing else. Two collaborators sit beside it:

| Class | Owns |
|---|---|
| `AgentRegistry` | identity: registration, credentials, rotation, token resolution, stats |
| `ApprovalService` | the approval lifecycle: raising, consent, quorum resolution, break-glass |
| `DecisionMemoryService` | the decision corpus: registration invariants, retrieval, digest, health |
| `ActionGateway` | identity → policy → advisors → approval → audit, composing the others |

A route module holds **no** logic — no store access, no filtering, no tallying,
no constructing a registry. It validates shapes and maps outcomes to status
codes. `memory.routes.ts` drifted from that and was pulled back; if a route grows
past shape-checking, the logic belongs in an application service.

Whether consent *exists* is `ApprovalService`'s call and rests on `evaluateConsent` — a pure
domain function in core. What to *do* with consent is the gateway's. Keep that seam: an
approval question that needs a store belongs in the service; one that needs only the record
belongs in `core/domain/approval-consent.ts`.

Routes talk to the service they need (`ctx.gateway.approvals.resolve(...)`), not to a facade
on the gateway. Do not add pass-through methods.

## Memnox governs agents; it is not one

**Memnox understands code. It never authors code, and it never reviews code.** The runtime reads a repository to build an import graph, reads a diff to scan for secrets, and reads a tool call to decide on it. It does not generate, edit, refactor, or commit anything on a user's behalf, and it never runs a sandbox to do so.

That is the whole product boundary. The predecessor codebase was an AI project manager that wrote code, planned sprints, and reviewed PRs; this one is the control plane that governs such agents. Governing an agent and being an agent cannot live in the same trust boundary.

### Gate, not reviewer

Memnox **gates** a change against policy — a deterministic allow / block / require-approval on a named action. It does not **review** a change: no opinions on code quality, no PR summaries, no suggested reviewers, no approve/request-changes on anyone's pull request.

The line matters because `memnox ci` and the content shield both read diffs. Reading a diff to answer *"does this violate a rule?"* is a gate. Reading it to answer *"is this good code?"* is a review, and does not belong here.

Out of scope, permanently: code generation, autonomous fix loops, execution sandboxes, PR review or commenting, reviewer suggestion, PR summarization, auto-approval of pull requests, sprint planning, task assignment.

The only files Memnox writes are its own: policy files, code-graph snapshots, editor hook configs, and its local stores.

- Dependency direction: interface → application → domain; infrastructure implements domain ports. Never import another package's internals — only its `index.ts`.
- **The decision path is deterministic**: no LLM, no network, no clock-as-input to a verdict, no randomness. Intelligence lives behind `LlmProvider` and can draft/explain, never decide.
- New escalation logic is an `ActionAdvisor`: escalation-only (never loosens), deterministic, and failure means "no escalation" — never a crash.
- Fail-closed on identity/provenance (unknown token, unreadable state); fail-open only where a broken guard would brick a developer tool (editor hook) — and say so in a comment.

## Rules

1. **No `any`** — use `unknown` + narrowing. Public and private async methods declare return types.
2. **No magic values** — constants live in a `*.constants.ts` or a module-level `const` above the class. `as const` objects + derived union types for enums.
3. **No `console.*` outside composition roots** (`console-logger.ts`, `cli-output.ts`, `cli/src/index.ts`, bench CLI). Everything else takes the `Logger` port; CLI commands take `CliOutput` via `CliContext`.
4. **Every `catch` logs or rethrows** — the only silent catches are documented first-run conditions ("file does not exist yet") with a one-line comment saying so.
5. **Comments: one line, WHY only.** Never restate the code; never leave commented-out code.
6. **Every behavior change ships with a test** (`packages/<name>/test`, vitest runs against source via aliases). New gateway paths append exactly one audit event.
7. **Secrets never appear as literals in test files** — assemble them at runtime (`['AKIA','…'].join('')`); the Security Shield hook blocks writes otherwise.
8. **Deterministic-IV encryption is banned** on anything searched by content (legacy scar; see ARCHITECTURE.md).
9. **No optional chaining (`?.`).** Write the check: `if (x === undefined) return …`. `?.` turns a broken invariant into a silent no-op — `child?.stdin?.write()` dropped an authorized MCP call and hung the client, with no log and no error. When a nested read off untrusted input is genuinely optional, give it a named helper (`fieldPath(payload, 'data', 'content')`) rather than a chain.

## Naming

| Thing | Convention | Example |
|---|---|---|
| Files | kebab-case | `action-gateway.ts`, `decision-registry.ts` |
| Classes | PascalCase | `PolicyEngine`, `TaintAdvisor` |
| Methods | camelCase verb-first | `authorize()`, `register()` |
| Constants | SCREAMING_SNAKE | `DECISION_EFFECT`, `APPROVAL_TTL_MS` |
| Route modules | `<domain>.routes.ts` exporting `register<Domain>Routes(app, ctx)` | `memory.routes.ts` |

## Ambient IO is a design smell

Two packages were once untestable for the same reason: they reached for `console`,
`process.stdin`, `spawn`, and global `fetch` from inside their logic. Both were
fixed by making the dependency an argument, and that is the pattern to follow.

| Surface | Seam |
|---|---|
| CLI commands | `registerXCommand(program, context)`; write via `context.out`, build clients via `context.client(options)` |
| A command's own ambient dependency | a defaulted third parameter — `DiffSource`, `ServerLauncher`, `EditorHookInstaller`, `HookHost`, `LlmProviderFactory` |
| MCP firewall | `FirewallSession` routes over an injected `FirewallChannel`; `McpFirewall` owns the child process and nothing else |
| HTTP | `MemnoxClient` accepts a `fetch` transport, so tests exercise real client code |

A dependency only one command needs stays that command's parameter — it does not
go on `CliContext`. The context is output and HTTP; widening it into a grab bag
forces every test to stub things it does not touch.

Never mock a module. If a test needs to reach into module internals, the
dependency belongs in the constructor instead.

## Verify before committing

`npm run format && npm run typecheck && npm test && npm run deadcode` — CI enforces all four plus the build, a publish dry run, and the Python, Go, Rust, Java, and Swift SDK suites.
