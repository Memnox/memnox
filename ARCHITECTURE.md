# Architecture

What the runtime is today. `VISION.md` is what it is being built toward; where the
two disagree, the intent has not shipped yet.

Read this before your first change. It is the map: four packages, one direction of
dependency, and one path that every decision travels down.

---

## The shape of it

```text
                  ┌──────────────────────────────────────────────┐
   an agent  ───► │  a seam                                      │
                  │  PATH wrapper · governed shell · MCP proxy   │
                  │  git hook · git credential · egress proxy    │
                  └───────────────────┬──────────────────────────┘
                                      │  ActionRequest
                                      ▼
                  ┌──────────────────────────────────────────────┐
                  │  LocalGate  (@memnox/core)                   │
                  │  PolicyEngine over the rule files on disk    │
                  └───────────────────┬──────────────────────────┘
                                      │  allow · ask · deny
                    ┌─────────────────┼─────────────────┐
                    ▼                 ▼                 ▼
              run the thing      hold for a        refuse, and name
                                  person            the alternative
                    └─────────────────┴─────────────────┘
                                      │
                                      ▼
                  ┌──────────────────────────────────────────────┐
                  │  the ledger  ~/.memnox/memnox.db, append-only │
                  │  read by  why · timeline · trace · collisions │
                  └──────────────────────────────────────────────┘
```

Nothing in that picture calls a network, and nothing consults a model.

**An agent may itself be several.** Hermes, OpenClaw and Ruflo are harnesses: they run
other agents, so they enter the picture at the left as one row and reach the seams as
several principals. They enforce their own tool policies and Memnox reads those rather
than ignoring them, so a tool a harness filtered out is not counted as reachable through
it. What a harness cannot see is the other harness on the same disk, the credentials
underneath it, and the shell they share, and that is exactly the seam this diagram is.
`docs/harnesses.md` has the whole story.

## The four packages

| Package | npm name | What it is |
|---|---|---|
| `packages/core` | `@memnox/core` | the domain: types, rules, discovery, the gate, the ledger |
| `packages/interceptors` | `@memnox/interceptors` | the seams an agent's own actions pass through |
| `packages/proxy` | `@memnox/proxy` | the MCP proxy, for what an agent reaches through a server |
| `packages/cli` | `memnox` | the commands, and every binary that ships |

Dependencies point one way and never back:

```text
cli ──► proxy ──► core
 └────► interceptors ──► core
```

`core` depends on nothing of ours. A package imports another only through its
`index.ts`, never a path into its internals.

Each package has its own README saying what is inside it. Start there when you know
which package your change belongs in, and here when you do not.

## The layers, and what may import what

| Layer | Lives in | May depend on |
|---|---|---|
| interface | `cli/src/commands/*.command.ts` and the `cli/src/commands/<name>/` folder beside a big one, `proxy` JSON-RPC, `interceptors` argv wrappers | its own package's application code |
| application | `cli/src/scan/`, `cli/src/protect/`, the seams, the firewall session | domain and ports |
| domain | `core/src/domain`, `policy`, `discovery`, `verbs`, `gate`, `ledger`, `recovery` | nothing but other domain code |
| infrastructure | `core`'s `Node*` adapters and `SqliteEventStore`, the config reader | the ports it implements |

**A command holds no logic.** It declares its flags, checks the shape of what it was
given, and calls something. When one grows past that, the logic moves out and the
test moves with it, which is what `cli/src/scan/` and `cli/src/protect/` are.

**A command with several subcommands registers them and nothing else.** `agents` and
`setup` each keep their wiring in `<name>.command.ts` and one `run*` function per
subcommand in `commands/<name>/`, so the registration file reads as a list of what the
command offers rather than as the work itself. `test/one-rail.test.ts` reads that folder
together with the command file, so splitting a handler out never moves it out of a check.

## The path a decision travels

Whichever seam catches an action, the middle of the journey is identical. That is
deliberate: one engine, one rule file format, one verdict vocabulary.

1. **A seam catches it.** A PATH wrapper (`memnox-intercept git push`), the governed
   shell (`$SHELL -c "..."`, split so each command in a line is ruled on separately),
   the MCP proxy (`tools/call`), a git hook, the git credential helper, the egress
   proxy, or a coding agent's own tool hook. Each turns what it caught into an `ActionRequest`: an action name, a target,
   arguments.
2. **The action is classified.** `verbs/` decides what `git push` or `aws s3 rm` counts
   as, whether read, write or destructive, from a table rather than a guess. Changing that table is
   changing what gets asked about, which is why it is reviewed as code.
3. **`LocalGate.evaluate` rules on it.** `PolicyEngine` matches the request against the
   rules loaded from disk, in layer order, with any freeze in force handed in rather
   than queried. It answers `allow`, `ask` or `deny` with the rule that decided and,
   on a deny, the alternative that rule names.
4. **The seam acts on the verdict.** Allow hands stdio over untouched and passes the
   real exit code back. Ask writes a hold and waits for a person, which is what lets a
   second terminal release something the first is still blocked on. Deny prints the
   rule, where it is declared, and what to use instead.
5. **The row is written.** `interceptors/src/record.ts` builds the frozen v1 event and
   appends it. Best effort and silent on failure: a ledger that stops the command is a
   tool somebody uninstalls.

In `observe` mode step 4 records the verdict and applies nothing, keeping what enforce
*would* have said in `shadowEffect`. That is the mode a new machine starts in.

**An agent's own tools meet the same rules.** `setup` installs `memnox-edit-hook
--policy` before every tool call each agent's hook system exposes, so a Read of
`~/.ssh`, a WebFetch or an MCP call is ruled on even where no wrapper stands in the
way. `interceptors/src/tool-calls.ts` maps each tool to an action: file reads, searches
and writes to `filesystem.read` or `filesystem.write` on the absolute path, a fetch to
`http.request` on its host, a command line through the shell classifier, and an MCP
tool to `mcp.<server>.<tool>`.

**A rule can tell a read from a change under the same name.** Every request carries
`toolClass` (read, write, destructive, communication or unknown) from whichever classifier
saw it: the verb tables for a CLI, the tool classifier by name for an MCP call, and the
tool table for an agent's own tools. A rule narrows itself with `classes`, and an
`http.request` names its `method`: `GET` for a fetch or a search, what argv says for `curl`
and `wget`, the one on the wire at the egress proxy, and `UNKNOWN` where nothing could
read it. The baseline asks about MCP tools that write, delete, send or cannot be
classified, about the write and delete verbs of the CLIs that act on somebody else's
system, and about `POST`, `PUT`, `PATCH`, `DELETE` and `UNKNOWN` requests, so reading
documentation, listing issues or describing instances never waits on a person. Such a rule
is left out of Claude Code's native permissions, which can only name a whole tool.

An allow says nothing, so the agent's own permission
prompt still runs, and a tool the table does not know is left to the agent. What each
agent's hook lets this enforce:

| Agent | Ruled on before it runs | Reply | Not enforceable |
|---|---|---|---|
| Claude Code | every tool (`PreToolUse`, matcher `*`) | allow is silence, `deny`, `ask` when a person is at it | `ask` in `bypassPermissions`, which is refused instead |
| Codex | every tool its `PreToolUse` reports (no matcher) | `deny` | `ask`, refused instead, since no prompt is documented |
| Gemini CLI | every tool (`BeforeTool`, matcher `.*`) | `{"decision":"deny"}` | `ask`, refused instead |
| Cursor | commands, MCP calls, file reads, writes | `permission` `deny`, `ask` for commands and MCP | the MCP server's name, which Cursor does not send, so its calls are `mcp.*.<tool>`; web fetches, which have no hook |
| Windsurf | reads, writes, commands, MCP calls | exit 2 with the reason on stderr | `ask`, refused instead; web fetches, which have no hook |

The row is written only where a rule spoke, something was held back, or observe kept
a verdict back, because the `PostToolUse` row already records every tool that ran.

**The same hook speaks inside the session, so the CLI stays the escape hatch.** At
`SessionStart` it adds a short block (`core/src/context/boundary.ts`, bounded by
`MOST_BOUNDARY_CHARS`): the mode, what the rules for this repository refuse and ask about,
the project boundary, any probation, and that a question is answered yes once or always.
A decision somebody already took (a team bundle rule, whose reason names who decided, a
machine rule dated from `decided-rules.json`, or the repository's own) is added as context
at `UserPromptSubmit` when the prompt names its path or action, and beside a `PreToolUse`
allow a rule spoke on, a few per call and each once per session. When a `PreToolUse` reply
asked, the call is kept by its `tool_use_id`; its `PostToolUse` arriving is the person's
yes, written as a `human` row with `authorizedBy` and taught to noticing. A call nobody
allowed never returns, so it leaves nothing. What each agent reads:

| Agent | Boundary at session start | Decisions | Yes learned from its prompt |
|---|---|---|---|
| Claude Code | `SessionStart` context | at a prompt and before a tool | yes |
| Codex | `SessionStart` context | at a prompt | no, since it never asks |
| Gemini CLI | `SessionStart` context | at a prompt (`BeforeAgent`) | no, since it never asks |
| Cursor | none, since its hooks add no context at a start | none | no, since its later payload carries no call id |
| Windsurf | none, since it reads nothing back | none | no |

The session files this keeps, under `~/.memnox/context/` and `~/.memnox/notice/sessions/`,
are swept at a session start, at most once a day and a bounded number at a time, once
untouched for a week.

## Where the state lives

Everything, under `~/.memnox` (`0700`, files `0600`) or `<project>/.memnox`. A change
that writes anywhere else says so and takes a backup first.

| Path | What |
|---|---|
| `~/.memnox/memnox.db` | the event ledger, append-only by database trigger |
| `~/.memnox/config.toml` | mode, retention, fail-open |
| `~/.memnox/account.json` | the enrolment, and the last mode the workspace set |
| `~/.memnox/policies.json` | the registry: which rule files this machine loads |
| `~/.memnox/machine.policies.toml` | the machine's own rules, the secret reads, registered so every repository loads them |
| `~/.memnox/bin/` | the PATH wrappers |
| `~/.memnox/guard/` | the seatbelt profile or Landlock ruleset |
| `~/.memnox/backup/` | configs `mcp wrap` rewrote, restored byte for byte by `unwrap` |
| `~/.memnox/transcripts/` | what an agent printed, when `run --transcript` asked for it |
| `~/.memnox/pending/` | held calls waiting for a person |
| `~/.memnox/overlays.json` | freezes and anything else true only for a while |
| `~/.memnox/stopped.json` | `memnox stop` in force: who, why, until when, and the mode `start` returns to |
| `~/.memnox/notice/` | what each agent has done before, as digests, and what each session took or was told, so every seam notices the same unusual action |
| `~/.memnox/context/` | per session, the decisions already said to it and the questions its own prompt is still answering |
| `memnox.policies.toml` | the rules, in the project, so they are reviewable and diffable |

**The mode is applied here, and a workspace can move it.** An enrolled machine
sends the mode it is running on every heartbeat and the reply carries the one the
workspace has set, so a fleet is taken from observe to enforce without anybody
reaching a box. It lands as a **change**, never as an assertion: `account.json`
keeps the last mode heard, and `config.toml` is rewritten only when the reply
differs from it. The alternative, writing what the reply says on every pass,
would revert an edit somebody made on purpose, within the minute, for ever, to a
file whose first line says it is theirs to edit. It is the same shape as the
bundle: applied on a change, a 304 otherwise. A machine with no account file
hears nothing, because nothing calls out at all.

**A stop is a file beside the mode, never a change to it.** `memnox stop` writes
`stopped.json` and leaves `config.toml` alone, so `start` returns to exactly the mode
somebody chose, and a heartbeat that moves the mode while stopped is not undone by the
start. Every seam asks `protectionStopped` before it rules: the tool hook reads `off`,
the hook authorizer and the proxy allow with the stop as the reason, and the PATH
interceptors hand straight to the real binary. The expiry is read by the seams
themselves, so a timed stop ends on time with no daemon; the keeper only records the
end and says so on the desktop, and puts nothing back while a stop holds. A stop is a
`config` row, which never reaches the control plane, so an enrolled machine reports it
under its own kinds, `machine.protection.stopped` and `machine.protection.started`.
Neither is on the cloud's `INTERNAL_KINDS`, because a machine reporting it went
ungoverned is the opposite of a machine promoting itself.

`cli/src/memnox-paths.ts` is where those paths are built. Two files spelling the same
path is how the kernel profile came to be written by one command and looked for by
another under a different name.

## Four properties the code is arranged to keep

**Deterministic.** A rule table and a matcher produce every verdict. No model is
consulted anywhere on an enforcement path, so a prompt cannot talk one around, and the
same input answers the same way a year later.

**A secret value never leaves the process that read it.** Discovery reports a path, a
kind and a count. The ledger stores a digest of arguments, never the arguments.
`validateEvent` refuses a digest field long enough to be a payload.

**A refusal names a way forward, and says whether to try again.** The alternative is
resolved from the rule that denied, never invented. An agent told only "no" abandons the
task; one told what to use instead finishes it, and one that cannot tell a rule from a
flaky server retries the rule until the budget is gone, which is why every refusal
carries its retryability.

**Nothing irreversible is handed over.** Reversibility is an input to the autonomy
bands, not a note beside them: a destructive action a milestone can undo is a smaller
decision than an ordinary one it cannot. A wrong ask costs an interruption; a wrong send
costs a sent email.

**It comes off cleanly.** `memnox uninstall` removes the wrappers, the hooks and the
wrapping; `--purge` takes the history and rules too. A tool that cannot be removed is
one people never install.

## The daemon notices drift, and the ledger keeps every config change

`keeper/keep-boundary.ts` puts back what setup drew. Every pass also takes a look
(`keeper/keep-watch.ts`): an unprobed scan, with tools read back from the last scan that
asked the servers, compared against the daemon's own baseline in `~/.memnox/keeper.json`
through `scan/machine-drift.ts`, which is the same comparison `memnox watch` runs. Looks
are at least thirty seconds apart, so one save or the keeper's own rewrite is one scan.
The daemon never starts an MCP server and never saves into the kept scan history.

Drift raises one desktop notice per kind of change and never more than three a pass.
Every keeper action and every drift item is appended to the ledger as a `config` row
naming the file and a before and after in words. The store leaves `config` rows out of
every query unless it passes `withConfig`, because they are not agent work: `timeline`,
`why <id>`, `trace` and `purge` ask for them, and budgets, `next`, `report`, collisions
and the push to the control plane do not. The control plane would read an action row as
a capability the agent holds, so config changes stay on the machine until it has a kind
for them.

An agent is dormant when it has been known for thirty days, holds a write tool, a
credential or a hook, and no ledger row names it inside the window. `status` and
`explain <agent>` show it, and the daemon mentions it once per stretch of silence.

## Memnox answers from inside the session, and never approves itself

Most of the time a person asks Memnox something where they already are, which is the
agent's conversation. `memnox-session` (`cli/src/session-tools/`) is a local stdio MCP
server each installed agent launches, with seven tools: `why`, `status`, `replay` and
`decisions` read the record and write nothing, `memory` and `brief` read what the
workspace has settled, and `rewind` is the one that acts. The daemon's heartbeat pulls
that memory into `~/.memnox/memory.json` beside the rules, and the hook matches it
against a prompt or a write's paths locally, so no network sits on a tool call. A tool
reads the session `memnox run` named in `MEMNOX_SESSION`, else the newest session of the
agent named on its launch line, and every answer is clipped, capped and masked, since it
lands in a model's context. No tool allows, approves, trusts, unfreezes, changes the mode
or edits a rule, because an agent that could call one would approve itself; the test
holds the list to that.

`rewind` is marked destructive so the host asks its person, asks again through
elicitation where the host offers it, refuses under CI or with no terminal and no way to
ask, and writes a `memnox.rewind` row whichever way it went. It restores through
`Milestones`, which keeps the current tree first, so a rewind is undoable.

The entry is named `memnox-session` and never `memnox`, because `memnox` is the cloud's
advisory entry that onboarding rewrites and offboarding deletes by name: two names means
neither door can take the other's entry. `planWrap` skips the binary, since wrapping it
would put Memnox in front of itself. `setup` adds the entry where each agent is
installed, the keeper puts a missing one back unless `memnox mcp session off` recorded
`session: false` in `kept.json`, and `uninstall` takes it out.

## Seams, and why the tests never touch your machine

Anything that would read `$HOME`, spawn a process, or watch a directory arrives as an
injected parameter with a real default:

```ts
export function registerCollisionsCommand(
  program: Command,
  context: CliContext,
  home: () => string = homedir,
  now: () => Date = () => new Date(),
): void
```

A test passes a fixture home and a fixed clock; production passes nothing. `CliContext`
carries output and styling the same way, which is why no command reaches for `console`
and why a suite of more than two thousand tests runs in a few seconds without a terminal.

**No test in that suite asserts a wall clock.** One measured ledger throughput and one
inferred parallelism from a stopwatch, and both failed on a loaded machine for reasons
that had nothing to do with the code, which teaches everybody to re-run the suite
rather than read it. Parallelism is now asserted by counting calls in flight at once,
and the throughput number lives in `pnpm bench`, where a slow answer means something.
A concurrency test that needs a delay uses a microtask, never a timer.

## Where to make a change

| You want to | Go to |
|---|---|
| change what `git push` counts as | `core/src/verbs/tables.ts`, and name the classes that moved, in the PR |
| add a rule field or matcher | `core/src/policy/` |
| detect a new agent or MCP client | `core/src/discovery/detectors/`: a data spec in `index.ts` when the layout is a config path, its own module when it needs parsing |
| detect a new harness, or what one hosts | `core/src/discovery/detectors/` for the layout, `core/src/discovery/harness.ts` for what a harness means |
| change what a set of tools adds up to | `core/src/discovery/composition.ts`, a verb table reviewed as code |
| find a new kind of credential | `core/src/discovery/credentials.ts` |
| add a flag to a command | the command file, then the folder beside it for what the flag does |
| add a command | `cli/src/commands/<name>.command.ts`, registered in `cli/src/program.ts`, and listed in its `SPINE` only if a newcomer needs it |
| add a subcommand to a big one | a `run*` function in `cli/src/commands/<name>/`, wired from `<name>.command.ts` |
| name a constant everything shares | see the table below; never a second copy in your own file |
| gate something an agent does directly | `interceptors/src/`, a new seam with its blind spots declared |
| change the event row | `core/src/event/`, where the v1 schema is frozen; see `docs/event-schema.md` |

## What every file looks like

One shape, so a reader who has seen one file has seen the pattern. `house-style.test.ts`
asserts the parts that were drifting.

```text
module doc comment      what this is, and the non-obvious why
imports                 node:, then packages, then @memnox/, then relative
constants               named, never a literal at the call site
types                   interface for a shape, type for a union
exported functions      what the module is for
helpers                 below what uses them, never exported unless another module needs them
```

Measured rather than decided, so a change here is a change to what the code already
does: 1293 function declarations against 0 arrow consts, 413 helpers below their caller
against 148 above, 260 readonly array parameters against 6 mutable ones that are not
mutated, and 0 default exports.

**A failure is reported differently per layer, and that is the rule.** The interface
layer throws, because a throw there is an error message and a non-zero exit: 59 of the
64 `throw new Error` in this repository are in `packages/cli`. The domain returns
absence instead, which is why `return null` is 126 in `core` and 78 in `interceptors`.
Where an operation has several distinct failures, it returns `{ outcome: OUTCOME.X }`
rather than a boolean. The five throws outside the CLI are invariant guards: a lock that
could not be taken, a harden step trying to write outside its root, a server command
that is missing.

A command is that shape with one addition: `register<X>Command` declares the flags and
delegates, and every `.action()` is a single call to a `run<Something>` function beside
it. A command with several subcommands keeps its runners in `commands/<name>/`.

## Where a shared constant lives

Nothing in this repository declares its own copy of a value another module already
names. A path spelled in two files is a path that will disagree with itself, and an
action name spelled in two files is a rule that silently stops firing.

| What | Where |
|---|---|
| an action name the seams emit and rules match | `core/src/constants/action.constants.ts` |
| a class, effect, mode or severity | `core/src/constants/` |
| a duration, or a conversion to and from milliseconds | `core/src/domain/time.ts` |
| an exit code, or a signal number | `core/src/domain/exit-code.ts` |
| an HTTP status | `core/src/sync/http-status.ts` |
| how many ledger rows a read takes | `core/src/ledger/ledger.constants.ts` |
| where an MCP client keeps its servers | `core/src/discovery/mcp-keys.ts` |
| the Memnox home, or the policy registry file | `core/src/config/config.ts` |
| a hash of a payload | `core/src/domain/digest.ts` |

## What is deliberately not here

No code review, no diff scanning, no risk score. Memnox rules on an action an agent
says it intends to take; it does not do the work, and it has no opinion about yours.

`docs/threat-model.md` says where this design would fail, including the parts no
PATH-based tool can close.
