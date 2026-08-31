# Memnox Runtime — Code Conventions

Read before writing code. Every rule exists because of a real mistake in the predecessor codebase or a deliberate architectural decision.

## Architecture (DDD layers)

```
interface       packages/cli, packages/runtime/src/routes, packages/sdk, sdks/*
                transports; validate shapes, map outcomes to codes, nothing else

application     ActionGateway, ApprovalService, AgentRegistry, DecisionRegistry
                orchestration + invariants; owns the pipeline

domain          packages/core, policy-engine, discovery, ledger, autonomy, workflow,
                memory, risk, org-graph
                pure types, constants, deterministic logic; core + policy-engine have ZERO deps

infrastructure  packages/runtime/src/stores, codecs, notifiers, @memnox/postgres, @memnox/redis
                adapters behind ports defined in core
```

### The phases the packages answer to

`VISION.md` is the build sequence: eleven phases, each answering one question. Cite one
by number when a change is answering to it (`§01` for the decision object, `§03` for
observe and learn, `§10` for what never ships).

| Package | Phase | Owns |
|---|---|---|
| `@memnox/discovery` | §00 | what can act here, what it reaches, findings, reversible harden steps |
| `@memnox/core` + `@memnox/policy-engine` | §01 | the decision object, declared scope, the explanation built from the match |
| `@memnox/mcp-firewall`, `CapabilityBroker` | §02 | seams, the MCP proxy **both ways**, capabilities and leases |
| `@memnox/tool-hook` | §02 | the five local seams: the PreToolUse hook, the shell wrapper, the git credential helper, the egress proxy, the Docker socket gate |
| `SeamService`, `LineageService` | §02, §03 | seams declaring themselves; who caused this, hop by hop |
| `@memnox/ledger`, `LearnService` | §03, §09 | frames, usage, unused grants, lineage, counterfactual, coverage, drift, chains, cost, incidents |
| `@memnox/organization`, `census-sources.ts` | §04 | subjects in three parts, the census, supply chain events, installs, the passport |
| `@memnox/policy-engine` | §05 | policies, proposals, simulation, blast radius |
| `DelegationService`, `ContainmentService` | §06 | chains that only narrow; kill, quarantine, panic |
| `@memnox/org-graph` | §07 | authority, ownership, state facts read as a policy input |
| `@memnox/workflow` | §08 | the gate invariant, the durable engine, runs, steps, briefings |
| `@memnox/autonomy`, `ReadinessService` | §10 | levels, readiness as queries, synthesis, role economics |

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

**Memnox is the organizational runtime.** It holds an organization's machine-readable operating model — what it knows, who may know it, who may do what, why, and what should happen next — and answers on that basis. It reads an action request and decides on it. It does not do the work.

That is the whole product boundary. The predecessor codebase was an AI project manager that wrote code, planned sprints, and reviewed PRs; this one is the control plane that governs such agents. Governing an agent and being an agent cannot live in the same trust boundary.

### The three things it owns

| Layer | Answers |
|---|---|
| Organizational context | what is known, who owns it, what was decided, and why |
| Governance & trust | who this is, what they may know, and what authority they hold |
| Execution control | may this action proceed, who approves it, and what actually happened |

### Gate, not worker

Memnox **gates** an action against policy — a deterministic **allow / withhold / escalate** on a named action, plus who authorizes it when nobody has. It does not perform the action, and it does not judge the work: no opinions on quality, no summaries of someone's change, no approve/request-changes on anyone's pull request.

Memnox does not read code. It has no import graph, no diff scanner, and no editor integration. An agent tells the runtime what it intends to do — action, target, environment — and the runtime rules on that request.

Out of scope, permanently: code generation, code review, diff or repository scanning, autonomous fix loops, execution sandboxes, PR review or commenting, reviewer suggestion, PR summarization, auto-approval of pull requests, sprint planning, task assignment.

The only files Memnox writes are its own: policy files and its local stores.

- Dependency direction: interface → application → domain; infrastructure implements domain ports. Never import another package's internals — only its `index.ts`.
- **The decision path is deterministic**: no LLM, no network, no clock-as-input to a verdict, no randomness, and a p99 under a millisecond in process. Intelligence lives behind `LlmProvider` and can draft, never decide and never explain.
- New escalation logic is an `ActionAdvisor`: escalation-only (never loosens), deterministic, and failure means "no escalation" — never a crash.
- Fail-closed on identity/provenance (unknown token, unreadable state). Where a surface fails open, say so in a comment and name what would break otherwise.

## The eight things a change must not undo

Each is an invariant with a test behind it. Breaking one is not a regression, it is a
different product.

1. **Three effects.** `allow`, `withhold`, `escalate`. The third keeps a governed system from being a wall. There is no fourth, and `redact` is not coming back — partial answers are a `withheld` count on an answer, not an effect on a decision.
2. **A refusal names an alternative.** `Decision.alternative` is resolved from the rule that withheld, never invented. An agent told only no abandons the task; one told what to use instead finishes it.
3. **Intent is declared, never inferred.** A client supplies the `Task` and its `declaredScope`; `compareDeclaredScope` compares and never judges. An undeclared dimension is `undeclared`, not a guess, and no model is consulted on this path — ever.
4. **Untrusted context cannot become authority.** `ContextBlock.trust` is a type, set by whoever supplied the block. A detector can be wrong; a type cannot be talked around.
5. **`shadowEffect` is always computed.** Observe and advise downgrade what is *applied*, never what was *decided*. Phase 03 has nothing to report and §05 nothing to simulate otherwise.
6. **The explanation is built from the match.** `buildExplanation` reads the decision, the request and the scope comparison. An explanation a model wrote afterwards is a plausible story about a decision, which is worse than none.
7. **Every harden step states its inverse.** `HardenStep.revert` is not optional, and the undo is printed before anything runs.
8. **A secret value never leaves the process that read it.** Discovery stores a path, a kind and a fingerprint; the ledger stores a `payloadDigest`. A report carrying the shape of somebody's SSH key is the worst bug this product could ship.
9. **The MCP proxy checks both directions.** The call on the way out, the result on the way back. A tool result is wrapped as an untrusted `ContextBlock` whatever it says, instruction-shaped content is recorded and framed rather than removed, and `promotedToIntent` is an invariant rather than a field anything sets.
10. **Containment names what it did not reach.** `ContainmentAction.unreached` is never empty because it was inconvenient. A kill reporting success while one machine is asleep is the worst possible lie, and the CLI exits non-zero on a partial one.
11. **A state fact carries an expiry.** `validateStateFact` refuses one without `validUntil`. A freeze that outlives its incident is worse than no freeze, because the next one gets ignored.
12. **Every route to a delegation passes a gate.** `validateWorkflow` walks backward from every delegate node to the trigger; a gated happy path proves nothing about the branch added underneath it later.

## What this codebase will not grow back

These were removed on purpose. Adding one back is a product decision, not a refactor.

- **A trust score.** A number that silently narrows a permission is unauditable. Authority is `autonomyLevel`: a named bundle of rules a person granted, in `@memnox/autonomy`.
- **A model explaining a decision.** `DecisionExplainer` is gone; `buildExplanation` replaced it.
- **A model inferring intent.** `IntentClassifier` is gone; a declared `Task` replaced it.
- **An estimated loss, a currency exposure, or hours saved in our voice.** Measured counts only; a modelled number takes its rate from the customer and is labelled as theirs.
- **A staged attack, a seeded workspace, or any fixture.** The demo is the reader's own machine. Every screen has to be honest when empty.
- **Irreversible hardening**, honeypots, agent certification, and any auto-containment a detector took without a person.

## Rules

1. **No `any`** — use `unknown` + narrowing. Public and private async methods declare return types.
2. **No magic values** — constants live in a `*.constants.ts` or a module-level `const` above the class. `as const` objects + derived union types for enums.
3. **No `console.*` outside composition roots** (`console-logger.ts`, `cli-output.ts`, `cli/src/index.ts`). Everything else takes the `Logger` port; CLI commands take `CliOutput` via `CliContext`.
4. **Every `catch` logs or rethrows** — the only silent catches are documented first-run conditions ("file does not exist yet") with a one-line comment saying so.
5. **Comments: one line, WHY only.** Never restate the code; never leave commented-out code.
6. **Every behavior change ships with a test** (`packages/<name>/test`, vitest runs against source via aliases). New gateway paths append exactly one audit event.
7. **Secrets never appear as literals in test files** — assemble them at runtime (`['AKIA','…'].join('')`).
8. **Deterministic-IV encryption is banned** on anything searched by content (legacy scar; see ARCHITECTURE.md).
9. **No optional chaining (`?.`).** Write the check: `if (x === undefined) return …`. `?.` turns a broken invariant into a silent no-op — `child?.stdin?.write()` dropped an authorized MCP call and hung the client, with no log and no error. When a nested read off untrusted input is genuinely optional, give it a named helper (`fieldPath(payload, 'data', 'content')`) rather than a chain.

## Command names

The product answers seven questions, so the CLI is named for them rather than for its
internals. A command is a plain word somebody would reach for: `check`, `rules`, `why`,
`audit`, `learn`, `coverage`, `census`, `queue`, `evidence`, `kill`, `panic`.

| The question | The command |
|---|---|
| what can act here | `memnox` (default), `doctor`, `harden` |
| should this proceed | `check` |
| what may it do | `rules`, `policy`, `simulate` |
| why | `why`, `why --evidence`, `replay` |
| who authorised it | `approvals`, `approve`, `deny`, `queue` |
| who is it | `agents`, `census`, `readiness` |
| what happened | `audit`, `learn`, `coverage`, `drift`, `evidence` |

Four names went and are not coming back: `explain` (a model narrating a decision),
`intent` (a model inferring one), `insights` (reporting about this product rather than
the organization), and `plan`. Two pairs merged, because one question deserves one
command: `context` + `describe` became `rules`, and `report` + `compliance` became
`evidence`. `trace` became `why --evidence`.

## Naming

| Thing | Convention | Example |
|---|---|---|
| Files | kebab-case | `action-gateway.ts`, `decision-registry.ts` |
| Classes | PascalCase | `PolicyEngine`, `CapabilityBroker` |
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
| A command's own ambient dependency | a defaulted third parameter — `ServerLauncher`, `MachineReaderFactory` |
| Discovery | every detector is a pure function of a `MachineReader`; `HardenWriter` takes what is written, and refuses any path outside the Memnox root |
| MCP firewall | `FirewallSession` routes over an injected `FirewallChannel`; `McpFirewall` owns the child process and nothing else |
| HTTP | `MemnoxClient` accepts a `fetch` transport, so tests exercise real client code |

A dependency only one command needs stays that command's parameter — it does not
go on `CliContext`. The context is output and HTTP; widening it into a grab bag
forces every test to stub things it does not touch.

Never mock a module. If a test needs to reach into module internals, the
dependency belongs in the constructor instead.

## Verify before committing

`npm run format && npm run typecheck && npm test && npm run deadcode` — CI enforces all four plus the build, a publish dry run, and the Python, Go, Rust, Java, and Swift SDK suites.
