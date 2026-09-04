# Memnox Runtime — Code Conventions

Read before writing code. Every rule exists because of a real mistake in the predecessor codebase or a deliberate architectural decision.

## Architecture (DDD layers)

```
interface       packages/cli, packages/runtime/src/routes, packages/sdk
                transports; validate shapes, map outcomes to codes, nothing else

application     ActionGateway, ApprovalService, AgentRegistry
                orchestration + invariants; owns the pipeline

domain          packages/core, policy-engine, discovery, ledger
                pure types, constants, deterministic logic; core + policy-engine have ZERO deps

infrastructure  packages/runtime/src/stores, packages/discovery snapshot store
                adapters behind ports defined in core (or, for discovery, in its own ports)
```

**This repository is the open half.** Everything one person needs to govern the agents on
their own machine, with no account and no network. Anything that only means something across
more than one person, and that needs somebody else's data to work, is the cloud and does not
belong here: identity across a fleet, organizational evidence, cost, SSO, SIEM. The
open/cloud table in `VISION.md` is the boundary, and it is drawn on that principle rather
than on a feature count.

### The phases the packages answer to

`VISION.md` is the vision, and it is written as **sixty pains** rather than as a sequence:
what is painfully happening today, why the tools somebody already has fail, what Memnox
does, what the user gets. They are numbered `2.1` to `2.60` inside its section 2. The one
sentence over all of it is that **Memnox solves the gap between what AI agents can do, what
they actually do, and what the organization intended**, which are this project's three kinds
of truth under the words a user would use.

The ten build phases still exist and are still how the packages are cited. **The phase index
in the appendix of `VISION.md` maps each `§NN` to the pains it closes**, so a change can name
either: `§01` for discovery, `§03` for observation, `§05` for protection, `§09` for policy
candidates, or `2.9` and `2.33` for the drift pains `@memnox/discovery` answers. Naming the
pain is better where one fits, because it says who is unblocked by the change.

**The vision is a brainstorm and says so**, in its own words: the pains should not
automatically become features. A screen drawn in it is an illustration of the pain, never a
committed output, and this file remains the authority on what the code actually does.

**§07 is open, and §08 is not.** Repository evidence is read from the reader's own checkout
with no account, which is why it ships here and why `evidence` states plainly that branch
protection lives in the forge and was not read. Organizational evidence — Slack, Jira,
Linear, Notion, Drive — needs somebody else's data and is the cloud.

| Package | Phase | Owns |
|---|---|---|
| `@memnox/discovery` | §01 | what can act here, what it reaches, findings, reversible harden steps |
| `@memnox/core` | §02 | the normalized model: the decision object, evidence, declared scope, the explanation built from the match |
| `@memnox/mcp-firewall` | §03 | seams, the MCP proxy **both ways** |
| `@memnox/tool-hook` | §03 | the five local seams: the PreToolUse hook, the shell wrapper, the git credential helper, the egress proxy, the Docker socket gate |
| `SeamService`, `LineageService` | §03 | seams declaring themselves; who caused this, hop by hop |
| `buildExplanation`, `why`, `rules`, `replay` | §04 | the deterministic answer, built from the match and never from a model |
| `@memnox/policy-engine` | §05 | policies, the three effects, proposals, simulation, blast radius, the compile into each agent's native control |
| `@memnox/ledger`, `LearnService` | §03, §06, §09 | frames, usage, unused grants, lineage, counterfactual, coverage, behaviour drift, collisions, repeated refusals, implicit authorization |
| `snapshotOf`, `compareSnapshots`, `authorityTrend`, `traceCapability` | §06 | what an environment held at one moment, what moved since, how far authority has travelled, and where one tool came from |
| `readRepositoryEvidence`, `findPolicyGaps` | §07 | what this repository states about itself, what it enforces, and the distance between the two — off the disk, with no forge and no login |
| `classifyActionClass` (core) | §03 | local, external state or destructive, taken from the verb rather than from the tool's name |
| `readinessFor` | §01 | what an agent holds towards an action, off the disk — never what a rule says about it |
| `concurrentWork`, `overlappingWork` | §03 | two agents in one file; two agents building one thing. Reported, never refereed |
| `ContainmentService` | §06 | kill, quarantine, panic and what each did not reach |
| `@memnox/runtime` | §02–§06 | the gateway and every service above it: identity, approvals, seams, lineage, learn, containment |
| `@memnox/local-gate` | §03 | the same rules evaluated in the process that makes the call, so arguments never travel |
| `@memnox/sdk` | §03 | `check`, `guard`, `governTools` — the client every seam and adapter is built on |
| `memnox` (`@memnox/cli`) | all | the command surface named in the table below |

### The application layer is split by responsibility

`ActionGateway` owns the decision pipeline and nothing else. Two collaborators sit beside it:

| Class | Owns |
|---|---|
| `AgentRegistry` | identity: registration, credentials, rotation, token resolution, stats |
| `ApprovalService` | the approval lifecycle: raising, consent, quorum resolution, break-glass |
| `ActionGateway` | identity → policy → advisors → approval → audit, composing the others |

A route module holds **no** logic — no store access, no filtering, no tallying,
no constructing a registry. It validates shapes and maps outcomes to status
codes. If a route grows past shape-checking, the logic belongs in an application
service.

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

## The fifteen things a change must not undo

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
11. **A state fact carries an expiry.** `validateStateFact` refuses one without `validUntil`, and `stateFactsInForce` takes the moment as an argument rather than reading a clock. A freeze that outlives its incident is worse than no freeze, because the next one gets ignored. Honoured on the decision path: the gateway and `LocalGate` pass `stateLabelsOf` into evaluation, so a rule naming `freeze:production` bites, and every verdict is stamped with the `stateVersion` it was decided against, so a bundle that never propagated is visible rather than silent. Where the fact *comes from* — a channel, an incident tool — is still the cloud's half.
12. **A change carries a direction.** `EnvironmentChange.direction` says whether authority widened or narrowed, and `summarizeChanges` counts both. A drift report that mixed a new credential with a removed one would be a list nobody can act on.
13. **An unreadable rule set is never an empty one.** `loadLocalRules` returns what would not load, and `memnox readiness` and `memnox watch` say so. Reporting "no rule covers this" about a machine whose rules simply failed to parse is a lie the reader would act on.
14. **An agent is enrolled with three fields.** `AgentIdentity` requires `kind` (the product), `role` (the job) and `principal` (the person). Policy matches on `roles`, so swapping the product leaves every rule about the job standing, and an incident report names a human rather than an API key. The route refuses an enrolment missing either — defaulted is not stated.
15. **A snapshot carries no file contents.** `snapshotOf` keeps names, counts and fingerprints. Snapshots live on disk for weeks, so the rule that a secret value never leaves the process that read it binds them hardest.

## What this codebase will not grow back

These were removed on purpose. Adding one back is a product decision, not a refactor.

- **A trust score.** A number that silently narrows a permission is unauditable. Authority is `autonomyLevel`: a named bundle of rules a person granted.
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
8. **Nothing is encrypted at rest, and nothing should start being.** Files are owner-only under the data directory. A keyring this runtime could not honestly promise to rotate was removed with the rest of the cloud half; key management across a fleet belongs there.
9. **No optional chaining (`?.`).** Write the check: `if (x === undefined) return …`. `?.` turns a broken invariant into a silent no-op — `child?.stdin?.write()` dropped an authorized MCP call and hung the client, with no log and no error. When a nested read off untrusted input is genuinely optional, give it a named helper (`fieldPath(payload, 'data', 'content')`) rather than a chain.

## Command names

The product answers a handful of questions, so the CLI is named for them rather than for
its internals. A command is a plain word somebody would reach for.

| The question | The command |
|---|---|
| what can act here | `memnox` (default), `scan`, `memnox --tools`, `doctor`, `doctor --by-agent`, `mcp review`, `harden` / `protect` |
| what changed, and where did it come from | `watch`, `diff`, `diff --trend`, `trace` |
| could it actually do this | `readiness` |
| can it do this, right now | `explain "<question>"` — technically, organizationally, and what is in force |
| which agents reach this | `who --resource <class>` — direct grants, and the reach that runs through a credential |
| should this proceed | `check` |
| what may it do | `rules` (with the seam each product enforces it at) |
| what is true right now | `state`, `state declare <kind>`, `state lift <id>` |
| what does this repository already say | `evidence`, `evidence --gaps`, `evidence --against-ledger` |
| why | `why`, `why --evidence`, `replay` |
| what if we widen it | `what-if` (`simulate`, `policy simulate`) |
| who authorised it | `approvals`, `approve`, `deny` |
| who is it | `agents` — enrolled with a product, a job and a person; `agents unregistered` for the ones acting here through no identity |
| what happened | `audit`, `learn`, `coverage`, `collisions` — two agents in one file, and three ordinary actions that added up to an export |
| stop it | `kill`, `quarantine`, `panic` |

Every one of them works with no account and no network, except the four that read the
runtime's own record over loopback.

**A command that answers no question is hidden rather than listed.** `init`, `validate`,
`hooks`, `stop`, `test` and `reload` still run and are still tested; they are operational
plumbing, and a help screen that lists them alongside the questions has stopped answering
any of them. Hidden is `{ noHelp: true }`, one word to undo. Deleting is different, and
`policy simulate` was deleted rather than hidden because it was the *same* command
registered twice: one question deserves one command, and it is `simulate` / `what-if`.

`scan` and `protect` are aliases of `discover` and `harden`: those are the words somebody
says out loud, and the product should answer to them. `doctor --by-agent` decomposes this
machine's findings per agent — never a safety rating of the products, which would be a claim
about software nobody tested.

**The four verbs of situation 60** are `explain`, `why`, `who` and `what-if`, and each is
answered from what is on this disk. `explain` reads the question by matching an agent
that is here and an action namespace that exists — deterministic, and it refuses rather
than guessing, because a model reading the sentence would be a model in the path of an
answer about authority. It is not the old `explain`, which was a model narrating a
decision after the fact and is not coming back.

Three names went and are not coming back: `intent` (a model inferring one), `insights`
(reporting about this product rather than the organization), and `plan`. Two pairs merged,
because one question deserves one command: `context` + `describe` became `rules`, and
`report` + `compliance` became `evidence` — which now answers §07: what this repository
states about itself, what it enforces, and the gap between. `trace` is capability
provenance — where a tool came from — and the evidence behind a decision is
`why --evidence`.

## Naming

| Thing | Convention | Example |
|---|---|---|
| Files | kebab-case | `action-gateway.ts`, `decision-registry.ts` |
| Classes | PascalCase | `PolicyEngine`, `ActionGateway` |
| Methods | camelCase verb-first | `authorize()`, `register()` |
| Constants | SCREAMING_SNAKE | `DECISION_EFFECT`, `APPROVAL_TTL_MS` |
| Route modules | `<domain>.routes.ts` exporting `register<Domain>Routes(app, ctx)` | `audit.routes.ts` |

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

`npm run format && npm run typecheck && npm test && npm run deadcode` — CI enforces all four plus the build and a publish dry run.
