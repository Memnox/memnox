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
| `--json` | the capability inventory (version 2) |

Agents are found by config file, never by a process list — JSON for the editors, TOML
for Codex, YAML for Hermes. Claude Code, Claude Desktop, Cursor, Codex, Cline and VS
Code are one row each. Hermes, OpenClaw and Ruflo run other
agents, so they get a `HARNESSES` block that counts the principals behind the row, and a
`COMBINED CAPABILITY` block for paths a set of permitted tools opens together.
[Harnesses](harnesses.md) explains both, and what Memnox deliberately leaves to them.

### `memnox agents`
The agents on this machine, and the channel to them. `discover` is the default.

| Command | What it does |
|---|---|
| `agents discover` | scan this machine, keep the scan, and report it if this machine is enrolled |
| `agents list` | what the last scan found, without taking a new one |
| `agents status <agent>` | one agent, and the file that proved each surface it has |
| `agents control [agent]` | collect what an operator has said, and acknowledge it |

All of it is about *this machine*. The console answers what the whole fleet runs,
because only something holding every machine's reports can, and answering that from
here would mean widening what a machine credential reaches.

`list` reads the kept scan rather than taking a fresh one, because a scan starts every
MCP server it finds: listing is the thing somebody runs twice in a row, and making it
the expensive one is how it stops being run. `discover` is the one that scans.

`control` is the only one that reaches the network, and it reaches it the way
everything else here does, which is by asking. Nothing dials this machine. What comes
back is a person's own words for whoever is at the agent, and it is never permission:
what the agent does next is decided here, against the rules already on disk.

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
how long it has been there.

An agent kind — `cursor`, `codex-cli`, `hermes` — gives what that product holds here:
the files that declared it, its surfaces, the MCP servers its own config names, whether
it holds a shell, and any path its tools open together.

It ends with **Governed by**: which seams are in front of *that* agent right now, and
the command that closes each one that is not. `doctor --wiring` answers the same
question for the machine, which is the wrong grain once there is more than one agent on
it — a wrapped Claude Code and an unwrapped Cursor average out to a number nobody can
act on.

```
  Governed by  3 of 4 seam(s)
    ✓  mcp         all 1 server(s) routed through the proxy
    ✓  shell       interceptors are ahead of the real binaries on PATH
    ✓  git         hooks in this repository stop a push even off PATH
    !  filesystem  covered by the shell wrapper only, so a raw binary is not stopped
                   → memnox protect --os-guard
```

A harness name — `hermes`, `openclaw`, `ruflo` — adds what it runs: the
runtimes it drives, the roles it defines, the hooks it installed into another product,
whether it works with agents on other machines, and any path its tools open together.
It never starts an MCP server, so the chain comes from the last scan that did; with no
such scan it says so rather than reporting an empty one. See
[Harnesses](harnesses.md).

An authenticated CLI name — `aws`, `gh`, `vercel` — gives the credential it uses and
the verb table enforcement reads.

A sentence asks a question:

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
reachable, agents that updated themselves, and a harness that gained a role, a hook
file or a federation link — which arrives without any config a client reads changing. It wakes when an agent's
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

### `memnox why`
Prints the rule, where it is declared, the reason and the alternative — and, for a git
action, what this repository already says about itself: branch protection, CODEOWNERS,
and whether the open pull request is approved and its checks are passing. All of it is
read-only through a CLI you are already logged into, and anything the forge did not
report is said as unknown rather than guessed at.

What Slack, the ticket tracker and the calendar say is not here and is not coming: that
needs a token on every laptop. It is the cloud's half of the same question.

### When a session is paused
An agent that retries the same failing command is stopped by the circuit breaker, and
the seam does it in process — there is no daemon to install and no counter to keep:

```
Paused by Memnox: npm.run has failed the same way 5 times; retrying it again will
fail the same way. Nothing further will run until a person looks at it.
A person can lift it with: memnox resume ses_overnight --by <them>
```

The **session** stops, not the command: the next thing that session tries is refused
too, because an agent that keeps working around a stopped loop is the thing being
stopped. `memnox resume <session> --by <you>` lifts it and the work continues.

The trip is reported after the action that caused it and enforced on the next one. The
action that tripped it has already run; holding it at that point would be a receipt
rather than a control.

### `memnox autopilot --role <name>` / `--roles`
A rule about a product is wrong the moment the team adopts a second one; a rule about
the job survives the tool being swapped underneath it. `--role` evaluates the boundary
as that job, so a `roles:` rule fires:

```
DEPLOYER — WHAT THIS JOB MAY DO
  a job, not a product — whichever agent is enrolled under it
```

`--roles` lists every job the rules name and what each may do, which is the question a
workforce raises — not "what may this binary do" but "who is allowed to do what":

```
  coder       5 on its own    0 asked    2 never
  deployer    3 on its own    0 asked    2 never
  tester      4 on its own    0 asked    2 never
```

Both are produced by asking the engine action by action, so what is on screen is what
will happen rather than a summary of what the rules intend. Enrol an agent with
`memnox run --role deployer -- <agent>`, and state the mission with `--task`.

A role is read from the rules, never from a roster: a job nothing has a rule about is a
name somebody typed once, and listing it would suggest it governs something.

### `memnox verify --enforcement`
Asks every seam to refuse something, and reports what came back. It plants a rule in a
scratch directory, attempts the thing the rule forbids through the MCP proxy and the
shell interceptor, and says whether the action was actually stopped.

```
  mcp         enforced      a forbidden tools/call was refused
  shell       enforced      a forbidden command was refused
  git         unproven      a hook is installed; proving it needs a real push
  filesystem  absent        no kernel profile, so a raw binary is not stopped
```

`doctor --wiring` reads the configuration; this one runs the action. The two answer
different questions, and the gap between them is where this product fails worst — a
proxy that is installed, routed, and loading no rules reports perfectly on the first
and fails the second.

The probe runs with **no `MEMNOX_POLICIES` set and its own `HOME`**, because that is
what an agent has: an editor opened from a dock icon carries no environment. A probe
that exported the variable would prove a seam *can* refuse rather than that it *will*.

**Absent never fails the command.** A machine with no egress proxy has declined the
test, not failed it, and going red for that teaches people to stop running the check.
Only a seam that was in place and let the action through exits non-zero.

### `memnox spend <usd>`
Records what an agent spent, so a dollar budget and the circuit breaker can see it.
`--session` defaults to `$MEMNOX_SESSION`, `--for` names the action it was spent on.

Memnox prices nothing. A model call's cost is knowable to the agent and to nobody else
on this machine, so the alternative to being told is a number nobody can derive — and
that is the figure a reader stops trusting the rest of the output over. A window with
no reported cost has no spend line rather than a reassuring `$0.00`.

### `memnox policy use [file]`
Registers a rule file, so every seam loads it. Writing `memnox.policies.toml` makes it
testable; registering it makes it enforced. `protect --apply` registers what it writes,
so this is for a file you wrote by hand.

`doctor --wiring` reports a readable rule file that nothing has registered as **broken**,
not ok: `policy test` answering DENY while every seam allows the same action is the one
state a health check must never print a clean number about.

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
Answers one, or `--group` to answer for every waiting call of the same kind.

**An `ask` rule now holds rather than denies.** The seam writes the question to
`~/.memnox/pending` and waits for whoever is actually there: the terminal, if
there is one; a second terminal running `memnox approve`; or the workspace,
whose answer arrives on the machine's next heartbeat. Nobody answering is a
timeout, said differently from a refusal, because a walk-away must not become a
yes — and the wait is bounded, so it cannot hang the agent either.

That last route is what makes an agent on somebody else's hardware answerable.
A question raised on a VPS at three in the morning is carried up on the
heartbeat, appears in the workspace's queue, and the answer comes back on the
next beat. Names only cross the wire: the operation and what it is about, never
the arguments.
Answers one. First answer wins; a second is told what already happened rather
than shown a failure.

## Running an agent

### `memnox mcp wrap` / `unwrap`
Repoints every MCP server at the proxy, backing up each config first. `unwrap`
restores byte for byte. `--dry-run` changes nothing.

It reads the Claude Code, Claude Desktop, Cursor, Cline, VS Code and OpenClaw configs
in your home directory, plus `.mcp.json` in the directory you are standing in — which
is where Ruflo registers its own server.

It reads Codex's TOML and Hermes' YAML too. Those two are **edited a line at a time**
rather than reserialised: only `command` and `args` change, and every other byte —
comments, key order, quoting style, block lists — is copied through, so `unwrap`
returns the file byte for byte as its author left it.

A server declared by URL has no launch line to repoint, so it is named and left alone
rather than turned into a command that would not start.

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


Declare what you asked for and it becomes enforceable: `--task "<statement>"`
with `--paths`, `--repos`, `--services`, `--envs` (comma separated) lets a rule
match on `scope`, and `--expect <count>` is what an action explosion is measured
against. `--role <name>` is the job the agent is enrolled under, matched by a
rule's `roles:`. A session that declares nothing is *undeclared* throughout,
never in violation — nothing is inferred.

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

### `memnox lock [path]`
Holds a path while you work on it, so a second agent waits instead of writing
over you. `--list` shows every lease on this machine, `--for <duration>` sets
how long, `--release <id>` lets one go early, `--forget` drops the records of
leases nobody holds.

It holds exactly the path you name, and the lease belongs to your shell rather
than to the command — so it is still there when you run the next one, and it is
released when that shell is gone.

Four rules keep this usable rather than a thing people turn off:

- **It locks paths, never meaning.** A write claims the directory it lands in,
  compared on segment boundaries — `src/billing` holds `src/billing/invoice.ts`
  and does not hold `src/billing-legacy`.
- **A lock never blocks a read.** Only write-class and destructive actions take
  or wait on a lease. Nothing here can make a reader wait.
- **Every lease expires**, and a holder whose process is gone is reclaimed
  rather than waited on.
- **A wait is always bounded.** When a path is held you are offered `[w]` wait,
  `[t]` take it anyway with a reason, `[d]` don't. A timeout is a refusal that
  names the holder, and taking it anyway is a row in the record, never a silent
  allow.

The seams take a lease on their own: a session writing ten files in one
directory holds one lease, not ten, and `memnox run` releases everything the
session held when the agent exits — including when it crashed.

When the machine is enrolled, the workspace's register is consulted too, so two
machines on one repository stop being a coin flip. It makes no call at all
without an account, and an unreachable control plane never stops a write: a
lease is coordination, not safety, and one that blocked work whenever the
network hiccuped is one people would turn off inside a day.

### `memnox next`
What you could safely stop being asked about. Reads the approval history and
names the things a person has already said yes to often enough that being asked
again is the tool wasting their attention. `--since <window>` to widen it.

Three rules keep it honest. One refusal is enough to stop a recommendation. A
destructive or outward action never rises past *supervised*, however routine it
became. And the ladder position is read off what is actually configured and
seen, not off what the config claims — an install that says *autonomous* while
asking about everything is telling you a story about yourself.

It prints counts, never hours. "Six hours a week you could get back" is a number
nobody can check, on a screen you are being asked to act on.

### `memnox autopilot [agent]`
What an agent would do on its own, in three bands: runs on its own, waits for
you, never. Every line is the verdict the engine actually reaches for that
action, asked one at a time — a screen that summarised the rules would be the
one you trust most and the one most likely to be subtly wrong.

Capabilities no rule covers are counted separately and never filed under "runs
on its own". It refuses to call a boundary ready when something destructive
would run unasked, or when more of what the agent can do is unruled than ruled.

### `memnox report`
What your agents did in a window and what of it was redone: actions, succeeded,
failed, blocked, held, and where the same work went twice.

Spend is whatever `memnox spend` reported and nothing else. A window nobody
reported a cost for says so instead of showing `$0.00` — a reassuring zero on a
screen about money is worse than an absence.

### `memnox budget`
How much an agent may do in a window, as against what it may do. `budget set
<name> --actions <patterns> --limit <n>` writes one, `--window day|hour|session`
and `--unit calls|usd`, `budget suggest --yes` writes a generous starting set,
`budget remove <name>` drops one. Counted from the ledger, so it survives a
restart and cannot be cleared by killing something.

Only what actually ran is charged: an action the rules refused never reached a
terminal, and charging for it would let a strict policy exhaust the budget it
was protecting. A `usd` budget counts only cost something else reports.

A budget can be counted across the fleet rather than on one machine — three
VPSs each allowed twenty pull requests a day is sixty, which is not what anybody
set. The workspace's total arrives on the heartbeat and is added to what this
machine has counted itself, so a control plane that cannot be reached degrades a
fleet budget to a machine budget rather than to no budget at all.

### `memnox paused` / `memnox resume <session>`
Sessions the circuit breaker is holding, and lifting one. The breaker watches
outcomes rather than requests, and holds a session on five identical failures,
eight failures in a row with nothing succeeding between them, an action count
far past what the task estimated, five actions outside the declared task, or a
spend ceiling. A pause names the count that produced it and says how to lift it:
a stop nobody can argue with or undo is one people work around by uninstalling.

### `memnox skills`
What your agents run on beyond their config, treated like deployments: skills
they wrote for themselves, and definitions somebody installed into them.
`--accept <name>` records that you have looked.

Two things are held. A skill or definition whose reach has grown since you
accepted it — yesterday it edited files, today it also names `kubectl`, or it
named four tools and now names none. And a roster that arrived all at once:
twelve or more new definitions in one directory is an install rather than
somebody's own work, and it is shown as one row with a count, never as three
hundred.

The count that matters is on that row. On Claude Code, Qwen and ZCode a
definition file with no `tools:` key inherits every tool in the session — the
shell, writes, and every connected MCP server — so an absent key is the widest
grant on the machine and not the narrowest. Public rosters run to hundreds of
files and almost none of them set it.

Two claims, kept apart. What a file *declares* is read out of its own header and
stated as fact. What it *names* is a match against the verb tables: evidence it
may use a tool, never proof that it does, and the screen says so.

### `memnox claims [session]`
What the agent said it did, against what the record says it did. Reads the
transcript from `memnox run --transcript`, or `--file <path>`. `contradicted` is
the one that matters: it ran, it failed, and somebody was told otherwise.
`unsupported` means nothing here recorded it, which is very often work done
somewhere this machine cannot see — never a finding of dishonesty.

### `memnox env`
The environment an agent needs when something other than `memnox run` starts it:
systemd, a container, a cron line. `--format sh|systemd|docker`, `--shell`,
`--session`.

`PATH` is expanded before printing for systemd and Docker, because neither runs
a shell — a literal `$PATH` in a unit file would make the interceptor directory
the whole path, which is an agent that can run nothing at all. Nothing here
edits a unit file.

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

**The control plane says where the approval page is**, in the `verificationUri`
of its answer. It has to: `--url` names an API, and on every deployment with a
console those are two different origins, so a page derived from the API base is
a page that does not exist. A control plane too old to say gets the derived
address as a fallback, which is right only where the two share an origin.

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

**Pulled:** a rule bundle, written to `~/.memnox/org.policies.json` and
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

**Collected by `memnox agents control`:** what an operator has said to an agent on
this machine, and a receipt saying it was collected. Two more paths on the same
credential, asked for the same way everything else here is asked for: nothing
dials this machine, and there is no connection held open waiting to be told. What
comes back is a person's own words and never a verdict, so collecting one changes
nothing about what the agent may then do. That is still decided here, against the
rules already on disk.

### What authenticates a pull

TLS, and the machine token. **The bundle carries no signature of its own**, so
https is required and `memnox login --url` refuses anything else, loopback aside.

What makes that sufficient rather than merely acceptable is the engine: rules
compose most-restrictive-wins, so a pulled rule can only ever *tighten* what this
machine already enforces. A control plane cannot grant your agent anything. The
worst a bad bundle can do is deny too much, which is visible immediately.

A bundle is applied whole or not at all: it is written to a temporary file, read
back through the same loader the gate uses, and renamed into place only once it
has parsed. A half-applied rule set is one nobody wrote.

### If it cannot reach the control plane
Nothing stops. The gate has already answered and the row is already written by
the time any of this runs, so a failed send loses a send and never a verdict.
The rows stay and the next pass retries them.

## Taking it back out

### `memnox uninstall`
Interceptors, git hooks and wrapping. `--purge` also deletes `~/.memnox`.
