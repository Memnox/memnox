# What can already act on this machine

Before any rules, any account and any network call, there is one question worth
answering: **what on this machine is already able to act, and what can it reach?**

That is the only aggregate that is true at minute zero. Everything else — what your
agents actually do, what they never needed, how much of it is governed — has to be
earned over a day of real work. This is read off your own disk, so it is true
immediately.

```bash
npx memnox
```

No account. No API key. No network call. Nothing is transmitted, which is the only
reason this is safe to run on a laptop that holds production credentials.

```
AI AGENTS               claude-code, claude-desktop, cursor, codex-cli
MCP CLIENTS             claude-code, cursor

REACHABLE FROM AN AGENT RIGHT NOW

  !  /Users/you/.ssh/id_ed25519      3 agents
  !  /Users/you/.docker/config.json  3 agents
  !  /Users/you/.npmrc               3 agents
  !  /var/run/docker.sock            3 agents

11 execution surfaces.

  memnox doctor   what is risky and why
  memnox harden   fix it, reversibly
```

## What it looked at, and what it kept

Agent config, MCP manifests, editor settings, shell profiles, CI workflow files,
container sockets, credential chains. It identifies the **kind, not the instance** —
Claude Code on four machines is one agent kind, or the roster is noise by week two.

**Finding a credential requires reading the file it lives in.** The value stays in the
process that read it and never reaches disk, a report, or a log. What is stored is a
path, a kind and a hash:

```bash
npx memnox --json | grep -c AKIA     # 0, always
```

`discover --json` also returns `read`: the list of every file it opened. The tool that
inspects your credentials can itself be inspected.

## Reachability is transitive

An agent that can run a shell reaches everything the shell reaches. Stating that plainly
is most of the value of the map — a report that listed only the surface an agent was
configured with would understate every coding agent on the machine.

Counts and names, never percentages. Forty two thousand files and two SSH keys is a
fact; eighty seven percent network is a feeling with no denominator.

## What is risky, and why

```bash
memnox doctor
```

Each finding names the agent, the resource, the evidence, and **the one change that
closes it**.

```
MEMNOX DOCTOR

  CRITICAL  /Users/you/.ssh/id_ed25519 is readable by 3 agent(s)
            /Users/you/.ssh/id_ed25519
            fix: withhold reads of /Users/you/.ssh/id_ed25519

  MEDIUM    a shell surface makes everything the user can reach reachable
            shell

Risk 89, from 7 finding(s) above. It grants nothing and compares this machine to no other.
```

The risk number is a decomposition of that list and nothing else. **It grants nothing,
it changes no permission, and it is never a rank against anybody else's machine.** There
is no estimated loss, and there never will be: a figure nobody can derive tells a
security reader the rest of the output is marketing.

## Close it, reversibly

```bash
memnox harden           # proposed, nothing changes
memnox harden --apply
memnox harden --revert  # a single command puts the machine back
```

**Every step prints its undo before it runs.** Changes land in Memnox policy and seam
config under `~/.memnox` — never in a file your team reviews, and never in your agent's
settings without your say-so.

```
PROPOSED

  1. withhold reads of /Users/you/.ssh/id_ed25519
     undo: memnox harden --revert hs_66674bcd

Nothing was changed. Run memnox harden --apply to write these.
```

Anything ambiguous defaults to advising rather than refusing. One over-eager default
breaking a build at midnight is the failure this product does not recover from.

Where a readable substitute exists, the rule it writes names it, so an agent refused
`.env` is told to read `.env.example` instead. Where none exists — a container socket
has no example beside it — the rule refuses and says nothing more. Sending an agent at a
path that is not there is worse than telling it no.

## What this does not do

- **No staged attack.** The demo is your own machine. There is no sample workspace, no
  seeded assistant, no simulated tool call. A machine with one agent and no findings
  reads as a real answer rather than a broken page.
- **No comparison score.** The number decomposes into your findings, and nothing else.
- **No irreversible change.** A step whose inverse cannot be stated is never proposed.

## Next

- [Getting started](getting-started.md) — from here to a governed agent.
- [Learning from behaviour](learning-from-behaviour.md) — the far stronger report, a day later.
