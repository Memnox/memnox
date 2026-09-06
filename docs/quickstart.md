# Quickstart

Nothing here needs an account, and nothing is sent anywhere.

## See what can act on this machine

```sh
npx memnox
```

That is `memnox scan`. It reads your agent configs, asks each MCP server what it holds,
and prints what is reachable. On most laptops the surprising line is a credential
reachable by three agents nobody granted it to.

```sh
memnox scan --tools            # every tool, by what it does
memnox scan --mcp github       # one server, before you trust it
memnox scan --save             # keep it, so "memnox diff" has a baseline
```

## Write rules

```sh
memnox protect                 # propose reversible steps, change nothing
memnox protect --apply         # write them
memnox protect --revert        # put it all back
```

Test a rule before you rely on it:

```sh
memnox policy test "git push --force"
```

## Put an agent behind the gate

```sh
memnox mcp wrap                # route every MCP server through the proxy
memnox run -- claude           # start the agent with interceptors and a session
```

`memnox mcp wrap` backs up each config first and `memnox mcp unwrap` restores it byte
for byte.

## Start in observe

```sh
memnox config get mode         # observe, on a new machine
memnox protect --enforce       # when the verdicts look right
```

Observe records the real verdict and denies nothing. Look at a few days of `memnox
timeline` before you switch.

## Leave it running

An `ask` rule holds the call for a person rather than denying it, so an agent can be
left alone without every held call becoming a refusal:

```sh
memnox autopilot               # what it would do alone, and what would still be asked
memnox approvals               # what is waiting; grouped by kind of work
memnox approve <id> --group    # one decision for every similar call
```

Four things stop work without a rule saying so. `memnox doctor` names whichever one is
in the way, so "my agent stopped and nothing says why" has an answer:

```sh
memnox paused                  # a loop the breaker stopped
memnox resume <session> --by <you>
memnox budget                  # what is left in the window
memnox lock --list             # who holds which path
```

Declaring what you asked for makes two of those sharper — a rule can match on scope,
and an action count far past the estimate is a signal rather than a guess:

```sh
memnox run --task "fix checkout" --paths 'src/checkout/**' --expect 40 -- claude
```

## What to hand over next

```sh
memnox next
```

What you have already approved often enough that being asked again is the tool wasting
your attention. Counts, never hours.

## Ask what happened

```sh
memnox timeline                # what the agents did, in order
memnox why                     # why the last refusal happened
memnox why --evidence          # the digests and the outcome behind it
memnox diff                    # what changed since the last scan
```

## Take it off

```sh
memnox uninstall               # interceptors, hooks and wrapping
memnox uninstall --purge       # and the history and rules too
```

## Governing an agent that is not started from a terminal

`memnox run -- <agent>` sets `PATH`, `SHELL`, the proxy variables and a session id for
the process it starts. That covers everything launched from a terminal: **Claude Code,
Codex, Hermes, OpenClaw** and a **Ruflo** swarm.

It cannot reach an app somebody opened from the dock. **Cursor, VS Code, Cline** and
**Claude Desktop** are windowed, so their environment comes from your login shell, not
from us. Three of the four seams still reach them, and the fourth is one line in a
profile:

| Seam | How it reaches a windowed app |
|---|---|
| MCP proxy | `memnox mcp wrap` — written into the config, so no environment is needed |
| git | `memnox protect --hooks` — a hook lives in the repository, whatever launched the editor |
| filesystem | `memnox protect --os-guard` — a kernel profile holds a denied path against any binary |
| shell (integrated terminal) | `memnox protect --interceptors`, then `memnox protect --path` and restart the app |

`--path` is the only thing Memnox ever writes outside `~/.memnox`, and it is opt-in by
name. The line is fenced by markers, so `memnox protect --revert-path` — and
`memnox uninstall` — take back exactly what we wrote and nothing either side of it.
It knows zsh from bash from fish: a `export PATH=` pasted into fish silently does
nothing, which is the worst kind of wrong.

### An agent started by systemd, a container, or cron

Nothing starts these from a terminal either, and they do not read a login shell — so
the `--path` line above never reaches them. Print what they need instead:

```sh
memnox env --format systemd    # Environment= lines for the [Service] section
memnox env --format docker     # ENV lines for a Dockerfile
memnox env                     # plain export lines
```

`PATH` is expanded before printing for both, because neither systemd nor Docker runs a
shell: a literal `$PATH` in a unit file would make the interceptor directory the whole
path, which is an agent that can run nothing at all. Nothing here edits a unit file —
a tool that rewrote your systemd configuration is one you would not install on a
server.

The machine also needs `~/.memnox` readable by the user the unit runs as. In a
container, mount it or install inside the image.

Ask any agent what is actually holding it:

```sh
memnox explain cursor
memnox explain codex-cli
```
