# Commands

Every command works with no account and no network.

Anywhere a flag names a stretch of time — `--since`, `--for`, `--usage`,
`--from-usage`, `--days` — it takes the same shapes: `30m`, `2h`, `7d`. A bare
number is read in whatever that flag is about, so `--for 30` is half an hour and
`--days 30` is a month. `--since` also takes an ISO timestamp.

## What can act here

### `memnox scan`
The default command — `npx memnox` runs it.

| Flag | What it does |
|---|---|
| `--tools` | every tool by class, server by server |
| `--mcp <server>` | one server: what it declares, asks for and reaches |
| `--usage <window>` | granted against used, e.g. `--usage 7d` |
| `--save` | keep this scan as a baseline for `diff` |
| `--no-probe` | do not start MCP servers; tools go uncounted |
| `--json` | the capability inventory |

### `memnox doctor`
What is reachable that should not be, ranked, each with the one change that closes it.
`--by-agent` decomposes per agent. Counts by severity, never a total.

`--wiring` answers a different question: is Memnox actually gating anything, or only
installed? It checks the config mode, the rules, the interceptors, whether they are
ahead of the real binaries on `PATH`, whether your MCP servers are routed through the
proxy, the daemon and the ledger. Every line that is not `ok` names the command that
fixes it.

### `memnox explain <subject>`
A tool name gives its provenance: which server, which config, which agents reach it,
how long it has been there. A sentence asks a question:

```sh
memnox explain "can claude read ~/.aws"
```

Answered from this disk in three rows — technically, runtime, policy. What the
organization intended is not on this disk, so it is not answered here.

## What changed

### `memnox diff`
| Flag | What it does |
|---|---|
| `--since <when>` | compare against the last scan at or before then |
| `--from` / `--to` | compare two kept scans |
| `--fail-on <gate>` | `any`, `write-capable` or `credential`; non-zero exit for CI |

A narrowing never trips `--fail-on`.

### `memnox watch`
Reports what arrived: new servers, new write tools, credentials that became
reachable, and agents that updated themselves. It wakes when an agent's
configuration changes, so a server added mid-watch shows up in seconds; the
`--interval` is the backstop, not the mechanism.

## Rules

### `memnox protect`
Proposes reversible steps by default and prints the undo before it runs anything.

| Flag | What it does |
|---|---|
| `--apply` | write the proposed steps |
| `--revert [id]` | undo one, or all of them |
| `--observe` / `--enforce` | set the mode |
| `--apply-native` | also write the rules into Claude Code's own permissions |
| `--revert-native` | take ours back out, leaving theirs |
| `--for <name>` | write rules for one CLI or MCP server only |
| `--from-usage <window>` | draft ask rules for what was granted and never used |
| `--interceptors` | install the PATH wrappers for every CLI this machine has |
| `--hooks` | install `pre-push` and `pre-commit` in this repository |
| `--os-guard` | write the kernel sandbox profile from your filesystem rules |
| `--interactive` / `--yes` | walk the domains, or take the recommendation |

`--interceptors` wraps only binaries that are actually installed: a shim for an
absent `aws` would answer `command -v aws` and send every script that checks for
it down the wrong branch. `--os-guard` is a second line under them, so a denied
path stays unreadable even to a binary that never saw a wrapper — and any pattern
the kernel cannot express as a literal subpath is printed rather than dropped.

### `memnox check "<intent>"`
Decides before the loop starts rather than interrupting it half an hour in. The same
engine, the same rules and the same state, run against the actions an intent resolves
to, with nothing executed. Exits non-zero when something would stop.

A command line is resolved exactly. A phrase resolves to every action it could mean —
"deploy payments" is railway, vercel and kubectl until somebody says which — and what
it was read as is printed, so a wrong reading is visible rather than mysterious.

### `memnox policy check [file]`
Reads every rule file this machine would load and says what is in force, what
moved and what will not parse. Without a file it checks the whole registry.

| Flag | What it does |
|---|---|
| `--prune` | forget registered paths that are no longer on the disk |

Exits non-zero when a file is broken, so a CI step can run it.

### `memnox policy test "<action>"`
Dry run. Prints the effect, the reason, the rule and the alternative. Exits non-zero
on anything that is not an allow, so it works in a hook.

### `memnox freeze [subject]`
Stops external-state actions for a while. Every freeze carries an expiry: one
that outlives its incident is worse than none, because the next one gets
ignored.

| Flag | What it does |
|---|---|
| `--for <window>` | how long, e.g. `2h` or `3d`. Defaults to two hours |
| `--reason <text>` | what the refusal will say |
| `--lift` | end it early; it stays in the record rather than vanishing |

### `memnox config`
`get`, `set` and `list`. Settings: `mode`, `retentionDays`, `failOpen`, `telemetry`.

## Calls waiting for a person

### `memnox approvals`
Calls held for somebody to answer. A hold written to disk is what lets a second
terminal — and later a platform lead in Slack — release something the first
terminal is still waiting on.

### `memnox approve <id>` / `memnox deny <id>`
Answers one. First answer wins; a second is told what already happened rather
than shown a failure.

## Running an agent

### `memnox mcp wrap` / `unwrap`
Repoints every MCP server at the proxy, backing up each config first. `unwrap`
restores byte for byte. `--dry-run` changes nothing.

### `memnox run -- <command>`
Starts an agent with the interceptor directory first on `PATH`, `SHELL` pointed at the
governed shell, and a session id. Hands back the agent's own exit code. When
`protect --os-guard` has written a profile, the agent starts inside it.

| Flag | What it does |
|---|---|
| `--shell <path>` | the shell the agent should use |
| `--transcript` | keep a local copy of what the agent printed |
| `--no-guard` | start outside the kernel sandbox even when a profile exists |

The governed shell obeys the shell contract: `$SHELL -c "<line>"` is what an
agent's Bash tool calls, and every command in that line is ruled on separately,
so `gh pr merge && vercel deploy` is two rulings rather than one opaque string.

### `memnox daemon`
Holds the rules in one process so an interceptor pays a connect instead of a file
read. Optional: an interceptor that cannot reach it evaluates in process instead.

## What happened

### `memnox timeline`
| Flag | What it does |
|---|---|
| `--session` / `--agent` | narrow to one |
| `--since <when>` | `30m`, `2h`, `7d` or an ISO timestamp |
| `--only <effect>` | `allow`, `ask`, `deny` or `blocked` |
| `--export <format>` | `jsonl` or `json` |

### `memnox why [id]`
The last thing that did not simply proceed. `--allowed` for the last allow,
`--evidence` for the digests and the outcome. Read back from the row, never
re-evaluated against today's rules.

### `memnox rewind`
Puts the working tree back to before an agent touched it. A milestone is a tree object
under `refs/memnox/` — never a commit, never a branch, never the stash — and a rewind
takes its own milestone first, so what it replaced is still reachable.

| Flag | What it does |
|---|---|
| `--list` | the milestones there are |
| `--to <id>` | a particular one, rather than the last |
| `--take` | keep the tree as it is now, restoring nothing |
| `--note <text>` | what this milestone is, for the listing |
| `--forget [keep]` | drop all but the newest few; the newest is never dropped |

It moves files and nothing else, it leaves ignored files alone, and it refuses outright
mid-merge or mid-rebase — a restore there would write over the state that says how to
finish. `memnox run` takes one automatically unless you pass `--no-milestone`.

### `memnox trace <id>`
One action end to end: the command, the rule that governed it, the exit code, the
duration and the argument digest. When the session kept a transcript, the tail of what
it printed. An id prefix is enough.

### `memnox collisions`
Two agents in one file, and two agents building one thing. `--since <when>` to
narrow the window.

### `memnox verify <bundle>`
Checks an exported bundle against its signature. Reports `valid`, `unsigned`,
`tampered` (the events do not match the digest) or `forged` (the signature does
not check out) — content first, so an edited bundle is never reported as merely
unsigned.

### `memnox purge`
Drops history past `retentionDays`. `--dry-run` says what would go.

## Connecting to a workspace

Optional, and off until you run it. Everything above works with no account, no
network and no key; this section is the only part of the runtime that talks to
anything, and it does nothing at all until `memnox login` has succeeded.

### `memnox login`
Connects this machine to a workspace, so it gets the rules that workspace
publishes. A device-code flow: it prints a code, opens the approval page, and
waits for somebody with access to approve it.

| Flag | What it does |
|---|---|
| `--url <base>` | the control plane, default `https://api.memnox.com` |
| `--enforce` | start in enforce rather than observe |
| `--no-open` | print the URL instead of opening a browser |

It writes `~/.memnox/account.json`, owner only: the workspace, a machine id, a
token scoped to this machine, and an Ed25519 private key generated here. **The
private key never leaves.** Anything that can read that file can act as this
machine, which is why it is `0600` and why `memnox logout` exists.

### `memnox logout`
Forgets the credential. Rules already pulled stay in force, because a machine
that silently stopped being governed the moment it lost its token would be a
worse failure than one that keeps the last rules it was given.

### `memnox sync`
Pulls the rules the workspace publishes and sends what happened. It runs on the
daemon's heartbeat, about once a minute, backing off to fifteen minutes while the
control plane is unreachable.

### `memnox sync now`
Does a pass immediately rather than waiting. `--json` for the result.

### What crosses the wire

**Pulled:** a signed rule bundle, written to `~/.memnox/org.policies.json` and
`~/.memnox/org-conditions.json`, where the engine already looks. An unchanged
bundle costs one `304`. Nothing about the pull is on the decision path: the gate
reads the file this wrote, minutes later, with no network anywhere near it.

**Sent, per action, in signed batches of at most 500:**

| Field | What it is |
|---|---|
| `dedupKey`, `subjectId` | the event id, so a resend is deduplicated |
| `occurredAt`, `agentSessionId` | when, and which session |
| `surface`, `operation`, `classes` | `shell`, `git.push-force`, `destructive` |
| `effect`, `reason`, `ruleId` | what was decided and which rule decided it |
| `resourceRef` | what it acted on: a path, a host, a branch |
| `argsDigest` | **a hash of the arguments, never the arguments** |
| `exitCode`, `startedAt` | how it ended and how long it took |
| `policyHash` | the rule set in force at the time |

**Never sent:** the arguments themselves, transcripts, file contents, credential
values, or anything under `~/.memnox/` other than the fields above. The payload is
an explicit allow-list in `sync/push.ts` rather than the event minus a blocklist,
so a field added to the ledger does not start travelling by accident.

**Sent on the heartbeat:** the hash of the bundle this machine has applied, which
is what lets a workspace see which machines are on which rules.

### If it cannot reach the control plane
Nothing stops. The gate has already answered and the row is already written by
the time any of this runs, so a failed send loses a send and never a verdict.
The rows stay and the next pass retries them.

## Taking it back out

### `memnox uninstall`
Interceptors, git hooks and wrapping. `--purge` also deletes `~/.memnox`.
