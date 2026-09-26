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
Codex, Cline, VS Code, and the three harnesses that run other agents: **Hermes**,
**OpenClaw** and **Ruflo**. On most machines one line is a surprise. This is a real
laptop, with the home directory shortened to `~`:

```
memnox scan

On this machine
agents       claude-code, claude-desktop, cursor, codex-cli, hermes
harnesses    hermes  1 principal
             hermes: no roles defined yet
mcp clients  cursor, codex-cli, hermes
mcp servers  next-devtools, node_repl, computer-use, memnox
tools        git, docker, kubectl, psql, mongosh, gh, railway, npm

Credentials these agents can read
!  ~/.ssh/id_ed25519       4 agents
!  ~/.config/gh/hosts.yml  4 agents
   github.com
!  ~/.railway/config.json  4 agents
!  ~/.docker/config.json   4 agents
!  ~/.npmrc                4 agents

What they can do with them, through a shell
!  docker   can push images to your registries · 2 destructive
!  gh       can merge pull requests and delete branches · 12 destructive
   github.com
!  railway  can deploy · 5 destructive
!  npm      can publish packages · 1 destructive

Reachable from an agent right now
!  ~/.ssh/id_ed25519      4 agents
!  ~/.docker/config.json  4 agents
!  ~/.npmrc               4 agents
!  /var/run/docker.sock   4 agents
!  network                5 agents
   unrestricted

14 execution surfaces.
135 capabilities can change something outside this laptop.
102 of them are governed by a policy.
```

Nobody granted that. It accumulated.

## When something runs other agents

Hermes, OpenClaw and Ruflo are harnesses: they route work, define roles, install hooks
and, in two cases, hand work to machines you are not looking at. One row on the roster
is several principals at the seam, so the scan says how many. Hermes with a CRM server
beside a Ruflo project that defines two roles reads:

```
On this machine
agents       hermes, ruflo
harnesses    hermes, ruflo  3 principals
             hermes: no roles defined yet
             ruflo: 2 roles · runs claude-code
definitions  2 installed into claude-code
             2 of them declare no tools, so each inherits every tool in the session
mcp clients  hermes  3 tools
mcp servers  crm
             1 more hidden by the host's own filter, so it is not counted here

Combined capability, where no single tool does this
!  hermes: customer data can leave, in one session
   crm.read_customer → crm.create_customer_export → crm.send_customer_report

  Each of these tools is ordinary. Holding all of them is the path.
```

Every tool in that chain is ordinary and passes review on its own. Holding all three is
a path, and a per-call allow-list is not shaped to notice it.

Memnox does not replace what those three enforce. Each filters its own tools and each is
right to, so a tool Hermes excluded is not counted as reachable through Hermes. What none
of them can see is the other two, the credentials on the disk underneath, and the shell
all three share. [Harnesses](docs/harnesses.md) is the whole story.

## What this is

Three questions, answered from your own disk:

| Question | Command |
|---|---|
| What can act here, and what can it reach? | `memnox scan` |
| What changed since last time? | `memnox scan --since yesterday`, `memnox watch` |
| May this action proceed? | `memnox protect`, `memnox policy test` |

And afterwards: `memnox timeline` for what happened, `memnox why` for why it was
decided that way.

## Putting your agents to work

One command does the whole first run:

```sh
memnox setup
```

It logs this machine in, finds the agents on it, and then goes one at a time:
what that agent can already reach, what you want to call it, and whether to put
it under Memnox. Nothing is onboarded without a yes, and nothing is touched for
the ones you refuse.

```
Claude Code
            claude-code
id          agt_claude-code
config      ~/.claude.json
mcp         github
can use     shell, filesystem, git, network, mcp
can reach   ~/.aws/credentials, network

  Call it something acme will recognise, or press Enter to keep "Claude Code"  > Backend Coder
  Put Backend Coder under Memnox now?  [Y/n] y
```

The name you give is the agent's identity in the workspace: it is sent with the
enrolment and it is what the console shows from then on. The control plane hashes
the hostname and never stores it, so without a name a fleet is a list of hex ids
nobody can tell apart.

The same steps are separate commands when you want them one at a time:

```sh
memnox agents discover         # find them, and say what you call each one
memnox agents list             # what is here, and which of them is onboarded
memnox agents onboard "Backend Coder" --name "Backend Coder"
```

`discover` asks for a name per agent and Enter keeps the detected one, so naming
costs a keystroke to skip. It never asks under `--json` and never asks when
nothing is attached to the terminal; `--name claude-code="Backend Coder"` is the
flag for a setup script.

The name is yours and the id is the identity. `agt_claude-code` is what every
ledger row is keyed on and it never moves; the name is what every screen prints,
and every command answers to either one.

## Inside the agent's session

After `memnox setup` there is nothing more to type. You start Claude Code, Codex or
Cursor the way you always do, and each agent's own hook asks Memnox before every tool
call: a file read or write, a shell command, a web fetch, an MCP call. The answer comes
back inside the conversation.

**When a session starts**, the agent is told where it stands, so it plans around your
rules instead of walking into them. A real one, in enforce mode on a connected machine:

```
Memnox: Memnox rules on this session in enforce mode: a rule that refuses stops the call, and one that asks puts the question to the person.
Project boundary: ~/work/api. A write outside it asks first.
When Memnox asks, the prompt puts the question to the person, who can say yes once or always; a refusal names what to use instead.
Your workspace has settled 1 decision(s), policies and owners. Before you change code, ask the memnox-session "brief" tool about the paths, or "memory" about the subject, and cite what it says.
```

**When a rule refuses**, the call never runs and the agent is told why and what to use
instead, so it carries on with the task rather than retrying.

**When a rule asks**, Claude Code shows its own permission prompt with Memnox's reason
in it. Say yes once, or for the rest of the session; a second yes to the same thing
stops the asking for that session. An agent with no prompt of its own relays the
question in the conversation, and you reply `yes`, `allow for this session` or `no`.
Turn on `memnox config set approvals both` and it reaches your Slack or Discord DM too,
where the first answer wins.

**When your prompt names something the workspace already settled**, or just before the
agent's first write to a file it covers, the decision is added to the conversation with
who confirmed it and where:

```
Your workspace settled this about payment retries: "Declined payments are never retried." (a decision, confirmed by ada@acme.com, on 2026-05-02, source https://acme.slack.com/archives/C01/p17).
```

**Ask Memnox through the agent**, in plain words. Every agent gets a small MCP server,
`memnox-session`, with seven tools:

| You say | Tool |
|---|---|
| "Why was that refused?" | `why` |
| "Where does Memnox stand?" | `status` |
| "What have you done this session?" | `replay` |
| "Would `git push --force` be allowed here?" | `decisions` |
| "What did we decide about retries, and who said so?" | `memory` |
| "Brief me on `src/payments` before you start" | `brief` |
| "Undo what you did this session" | `rewind` |

Every tool but `rewind` only reads, and `rewind` waits for your yes before it moves a
file. None of them can allow, approve or change a rule, and an agent that tries
`memnox allow`, `memnox mode off` or an edit to a rule file from its shell is refused
before any rule is read, since an agent that could would approve itself.

**What each agent's hook lets Memnox do:**

| Agent | Checked before it runs | A question goes to | Told at session start |
|---|---|---|---|
| Claude Code | every tool | its own permission prompt | yes |
| Codex | every tool its hook reports | the conversation | yes |
| Gemini CLI | every tool | the conversation | yes |
| Cursor | commands, MCP calls, file reads and writes | its own prompt for commands and MCP calls | no, only what `memnox-session` says when it connects |
| Windsurf | commands, MCP calls, file reads and writes | `memnox approve`, the workspace or your DM | no, only what `memnox-session` says when it connects |

Switching to `memnox protect --enforce` reaches an open session on its next tool call.
MCP servers the agent already started, and the note it read at the start, catch up when
you restart the agent. [Everything from inside the session](docs/use-cases.md#20-everything-from-inside-the-session)
has the whole story.

## Governing an agent

```sh
memnox protect                 # propose reversible steps; changes nothing
memnox protect --apply         # write them; the undo is printed first
memnox mcp wrap                # route every MCP server through the proxy
memnox run -- claude           # start the agent behind the gate
```

A refusal always names a way forward. With the rules `memnox protect --yes` writes:

```
$ memnox policy test "git push --force origin main"

git push --force origin main
verdict     DENY
reason      you chose to deny this: it rewrites history somebody else may already have pulled
rule        git-deny
instead     push a branch and open a PR

DENY  git push --force origin main
Nothing was run, and nothing on this machine changed.
```

The agent that typed it is told the same, and that retrying will fail identically.

An agent told only "no" abandons the task. One told what to use instead finishes it.

## Leaving it running

The point of a boundary is not that it refuses things. It is that you can walk away.

```sh
memnox next --agent claude-code  # what it would do alone, and what it would ask about
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
count that produced it and can always be lifted, because a stop nobody can argue with
is one people work around by uninstalling.

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
across the fleet rather than once per machine, and when the control plane cannot be
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

Node 22 or newer, on macOS or Linux. On Windows, run it inside WSL, and
[ADR 0001](docs/adr/0001-windows-support.md) says why.

After `memnox setup`, Memnox lives in your agent session, and the terminal needs a
handful of commands:

```sh
memnox setup      # put this machine under Memnox, once
memnox status     # where this machine stands
memnox rewind     # undo what an agent did to your files
memnox doctor     # check the wiring, and prove it holds
memnox stop       # turn protection off on purpose and on the record, e.g. --for 30m
memnox start      # turn it back on, in the mode it was stopped in
memnox update     # the latest version, with the wiring pointed at it
```

`memnox login` connects the machine to your team. Everything else happens in your agent
session, and `memnox help --all` lists every command.

## Documentation

- [Quickstart](docs/quickstart.md)
- [Commands](docs/commands.md): every command and flag
- [Harnesses](docs/harnesses.md): Hermes, OpenClaw, Ruflo, and combined capability
- [Policies](docs/policies.md): the rule file
- [Risk bands](docs/risk-bands.md): how a band is decided, rule by rule
- [Event schema](docs/event-schema.md): the frozen v1 row
- [Threat model](docs/threat-model.md), including where it would fail
- [FAQ](docs/faq.md), starting with "does it call an LLM?" (no)
- [Architecture](ARCHITECTURE.md): how the code is put together

## What it deliberately does not do

No code review. No diff scanning. No risk score, because a single number is unarguable,
and an unarguable number is one nobody acts on. There are counts by severity and a band
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
