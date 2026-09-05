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
prints what is reachable from where. On most machines one line is a surprise:

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
DENY  git.push origin main
  reason      main is shared, and a force push loses somebody's work
  rule        no-force-push-to-main  (project layer)
  declared in memnox.policies.yaml:12

  Instead:  git.push a branch
            Push a branch and open a PR.
```

An agent told only "no" abandons the task. One told what to use instead finishes it.

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

Node 20 or newer, on macOS or Linux. On Windows, run it inside WSL —
[ADR 0001](docs/adr/0001-windows-support.md) says why.

## Documentation

- [Quickstart](docs/quickstart.md)
- [Commands](docs/commands.md) — every command and flag
- [Policies](docs/policies.md) — the rule file
- [Risk bands](docs/risk-bands.md) — how a band is decided, rule by rule
- [Event schema](docs/event-schema.md) — the frozen v1 row
- [Threat model](docs/threat-model.md) — including where it would fail
- [FAQ](docs/faq.md) — starting with "does it call an LLM?" (no)

## What it deliberately does not do

No code review. No diff scanning. No risk score — a single number is unarguable, and
an unarguable number is one nobody acts on. There are counts by severity and a band
that names every rule that fired.

Memnox rules on an action an agent says it intends to take. It does not do the work,
and it has no opinion about yours.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md). Every change ships with a test, and
`pnpm typecheck && pnpm test && pnpm deadcode` has to pass.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
