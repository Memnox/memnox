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
`index.ts` — never a path into its internals.

Each package has its own README saying what is inside it. Start there when you know
which package your change belongs in, and here when you do not.

## The layers, and what may import what

| Layer | Lives in | May depend on |
|---|---|---|
| interface | `cli/src/commands/*.command.ts`, `proxy` JSON-RPC, `interceptors` argv wrappers | its own package's application code |
| application | `cli/src/scan/`, `cli/src/protect/`, the seams, the firewall session | domain and ports |
| domain | `core/src/domain`, `policy`, `discovery`, `verbs`, `gate`, `ledger`, `recovery` | nothing but other domain code |
| infrastructure | `core`'s `Node*` adapters and `SqliteEventStore`, the config reader | the ports it implements |

**A command holds no logic.** It declares its flags, checks the shape of what it was
given, and calls something. When one grows past that, the logic moves out and the
test moves with it — that is what `cli/src/scan/` and `cli/src/protect/` are.

## The path a decision travels

Whichever seam catches an action, the middle of the journey is identical. That is
deliberate: one engine, one rule file format, one verdict vocabulary.

1. **A seam catches it.** A PATH wrapper (`memnox-intercept git push`), the governed
   shell (`$SHELL -c "..."`, split so each command in a line is ruled on separately),
   the MCP proxy (`tools/call`), a git hook, the git credential helper, or the egress
   proxy. Each turns what it caught into an `ActionRequest`: an action name, a target,
   arguments.
2. **The action is classified.** `verbs/` decides what `git push` or `aws s3 rm` counts
   as — read, write, or destructive — from a table, not a guess. Changing that table is
   changing what gets asked about, which is why it is reviewed as code.
3. **`LocalGate.evaluate` rules on it.** `PolicyEngine` matches the request against the
   rules loaded from disk, in layer order, with any freeze in force handed in rather
   than queried. It answers `allow`, `ask` or `deny` with the rule that decided and,
   on a deny, the alternative that rule names.
4. **The seam acts on the verdict.** Allow hands stdio over untouched and passes the
   real exit code back. Ask writes a hold and waits for a person — which is what lets a
   second terminal release something the first is still blocked on. Deny prints the
   rule, where it is declared, and what to use instead.
5. **The row is written.** `interceptors/src/record.ts` builds the frozen v1 event and
   appends it. Best effort and silent on failure: a ledger that stops the command is a
   tool somebody uninstalls.

In `observe` mode step 4 records the verdict and applies nothing, keeping what enforce
*would* have said in `shadowEffect`. That is the mode a new machine starts in.

## Where the state lives

Everything, under `~/.memnox` (`0700`, files `0600`) or `<project>/.memnox`. A change
that writes anywhere else says so and takes a backup first.

| Path | What |
|---|---|
| `~/.memnox/memnox.db` | the event ledger, append-only by database trigger |
| `~/.memnox/config.json` | mode, retention, fail-open |
| `~/.memnox/policies.json` | the registry: which rule files this machine loads |
| `~/.memnox/bin/` | the PATH wrappers |
| `~/.memnox/guard/` | the seatbelt profile or Landlock ruleset |
| `~/.memnox/backup/` | configs `mcp wrap` rewrote, restored byte for byte by `unwrap` |
| `~/.memnox/transcripts/` | what an agent printed, when `run --transcript` asked for it |
| `~/.memnox/pending/` | held calls waiting for a person |
| `~/.memnox/overlays.json` | freezes and anything else true only for a while |
| `memnox.policies.toml` | the rules, in the project — reviewable and diffable |

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

**A refusal names a way forward.** The alternative is resolved from the rule that
denied, never invented. An agent told only "no" abandons the task; one told what to
use instead finishes it.

**It comes off cleanly.** `memnox uninstall` removes the wrappers, the hooks and the
wrapping; `--purge` takes the history and rules too. A tool that cannot be removed is
one people never install.

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
and why a suite of 1000 tests runs in three seconds without a terminal.

## Where to make a change

| You want to | Go to |
|---|---|
| change what `git push` counts as | `core/src/verbs/tables.ts` — and name the classes that moved, in the PR |
| add a rule field or matcher | `core/src/policy/` |
| detect a new agent or MCP client | `core/src/discovery/detectors/` |
| find a new kind of credential | `core/src/discovery/credentials.ts` |
| add a flag to a command | the command file, then the folder beside it for what the flag does |
| add a command | `cli/src/commands/<name>.command.ts`, registered in `cli/src/program.ts` |
| gate something an agent does directly | `interceptors/src/` — a new seam, with its blind spots declared |
| change the event row | `core/src/event/` — the v1 schema is frozen; see `docs/event-schema.md` |

## What is deliberately not here

No code review, no diff scanning, no risk score. Memnox rules on an action an agent
says it intends to take; it does not do the work, and it has no opinion about yours.

`docs/threat-model.md` says where this design would fail, including the parts no
PATH-based tool can close.
