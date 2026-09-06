<p align="center">
  <img src="assets/logo.png" alt="Memnox" width="96">
</p>

<h1 align="center">Memnox</h1>

<p align="center">
  <strong>See what your AI agents can actually reach. Then decide what they may do.</strong>
</p>

<p align="center">
  No account. No network. Nothing leaves your machine.
</p>

---

```sh
npx memnox
```

That reads the agent configs on your laptop, asks each MCP server what it holds, and
prints what is reachable from where. It knows Claude Code, Claude Desktop, Cursor,
Codex, Cline, VS Code, and the three harnesses that run other agents — **Hermes**,
**OpenClaw** and **Ruflo**. On most machines one line is a surprise:

```
AI AGENTS               claude-code, claude-desktop, cursor, codex-cli
MCP CLIENTS             claude-code, cursor
MCP SERVERS             github, filesystem, postgres
TOOLS                   git, docker, kubectl, psql

REACHABLE FROM AN AGENT RIGHT NOW

  !  ~/.ssh/id_ed25519          3 agents
  !  ~/.aws/credentials         3 agents
  !  network                    4 agents
     unrestricted

11 execution surfaces.
```

Nobody granted that. It accumulated.

## When something runs other agents

Hermes, OpenClaw and Ruflo are harnesses: they route work, define roles, install hooks
and, in two cases, hand work to machines you are not looking at. One row on the roster
is several principals at the seam, so the scan says how many:

```
HARNESSES               hermes, ruflo  9 principals
  hermes: 3 roles
  ruflo: 5 roles · runs claude-code, codex-cli · 2 hook files · federated across machines

COMBINED CAPABILITY  (no single tool does this)

  !  hermes: customer data can leave, in one session
     crm.read_customer → crm.create_customer_export → slack.send_customer_file
```

Every tool in that chain is ordinary and passes review on its own. Holding all three is
a path, and a per-call allow-list is not shaped to notice it.

Memnox does not replace what those three enforce. Each filters its own tools and each is
right to — a tool Hermes excluded is not counted as reachable through Hermes. What none
of them can see is the other two, the credentials on the disk underneath, and the shell
all three share. [Harnesses](docs/harnesses.md) is the whole story.

## What this is

Three questions, answered from your own disk:

| Question | Command |
|---|---|
| What can act here, and what can it reach? | `memnox scan` |
| What changed since last time? | `memnox diff`, `memnox watch` |
| May this action proceed? | `memnox protect`, `memnox policy test` |

And afterwards: `memnox timeline` for what happened, `memnox why` for why it was
decided that way.

## Governing an agent

```sh
memnox protect                 # propose reversible steps; changes nothing
memnox protect --apply         # write them; the undo is printed first
memnox mcp wrap                # route every MCP server through the proxy
memnox run -- claude           # start the agent behind the gate
```

A refusal always names a way forward:

```
DENY  git.push-force origin main
  reason      main is shared, and a force push loses somebody's work
  rule        no-force-push-to-main  (project layer)
  declared in memnox.policies.toml:12

  Instead:  git.push a branch
            Push a branch and open a PR.
```

An agent told only "no" abandons the task. One told what to use instead finishes it.

## Leaving it running

The point of a boundary is not that it refuses things. It is that you can walk away.

```sh
memnox autopilot               # what it would do alone, and what would still be asked
memnox run --task "fix checkout" --paths 'src/checkout/**' -- claude
```

An `ask` rule holds the call for a person instead of denying it. Answer it at the
terminal, or from anywhere:

```sh
memnox approvals               # grouped: five similar calls are one decision
memnox approve <id> --group
```

While it runs, four things stop work without a rule saying so, and each says why:

```
memnox paused                  # a loop the breaker stopped, and how to lift it
memnox budget                  # what is left in the window
memnox lock --list             # who holds which path
memnox doctor                  # names whichever of those is in the way
```

The breaker watches outcomes, not requests: the same command failing the same way
five times, eight failures with nothing succeeding between them, an action count far
past what the task estimated, or work outside what was asked for. A pause names the
count that produced it and can always be lifted — a stop nobody can argue with is one
people work around by uninstalling.

## What you could hand over next

```sh
memnox next
```

Reads what you have already approved and names the things you have said yes to often
enough that being asked again is the tool wasting your attention. One refusal stops a
recommendation, and destructive or outward actions never rise past supervised however
routine they became.

It prints counts, never hours. "Six hours a week you could get back" is a number
nobody can check.

## On a server

`memnox run` puts the seams in front of an agent it starts. Nothing starts an agent
running under systemd or in a container, and neither reads a shell profile:

```sh
memnox env --format systemd    # the lines a unit file needs
memnox env --format docker
```

With a workspace, a question raised on a box nobody can reach travels up on the
heartbeat and the answer comes back on the next one. Leases and budgets are counted
across the fleet rather than once per machine — and when the control plane cannot be
reached, each degrades to the local answer rather than blocking work.

## It starts in observe

A tool that denies something important on its first day gets uninstalled on its first
day. Observe records the real verdict and applies nothing:

```sh
memnox config get mode         # observe
memnox timeline                # look at a few days
memnox protect --enforce       # when the verdicts look right
```

## Three promises

**No model decides anything.** Every verdict comes from a rule table and a matcher.
A model is not consulted, so a prompt cannot talk one around.

**A secret value never leaves the process that read it.** What is stored is a path, a
kind and a fingerprint. The event schema refuses a digest field long enough to be a
payload.

**It comes off cleanly.** `memnox uninstall` removes the interceptors, the hooks and
the wrapping. `--purge` takes the history and rules too. A tool that cannot be removed
is one people never install.

## Install

```sh
npm install -g memnox     # or just use npx
```

Node 22 or newer, on macOS or Linux. On Windows, run it inside WSL —
[ADR 0001](docs/adr/0001-windows-support.md) says why.

## Documentation

- [Quickstart](docs/quickstart.md)
- [Commands](docs/commands.md) — every command and flag
- [Harnesses](docs/harnesses.md) — Hermes, OpenClaw, Ruflo, and combined capability
- [Policies](docs/policies.md) — the rule file
- [Risk bands](docs/risk-bands.md) — how a band is decided, rule by rule
- [Event schema](docs/event-schema.md) — the frozen v1 row
- [Threat model](docs/threat-model.md) — including where it would fail
- [FAQ](docs/faq.md) — starting with "does it call an LLM?" (no)
- [Architecture](ARCHITECTURE.md) — how the code is put together

## What it deliberately does not do

No code review. No diff scanning. No risk score — a single number is unarguable, and
an unarguable number is one nobody acts on. There are counts by severity and a band
that names every rule that fired.

Memnox rules on an action an agent says it intends to take. It does not do the work,
and it has no opinion about yours.

## Contributing

[ARCHITECTURE.md](ARCHITECTURE.md) is the map: four packages, one direction of
dependency, and one path every decision travels down. It ends with a table of where
to make each kind of change.

[CONTRIBUTING.md](CONTRIBUTING.md) is how a change lands. Every change ships with a
test, and `pnpm format && pnpm typecheck && pnpm test && pnpm deadcode` has to pass.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
