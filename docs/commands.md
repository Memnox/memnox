# Commands

Every command works with no account and no network.

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
Rescans on an interval and reports what arrived: new servers, new write tools,
credentials that became reachable, and agents that updated themselves.

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

### `memnox policy test "<action>"`
Dry run. Prints the effect, the reason, the rule and the alternative. Exits non-zero
on anything that is not an allow, so it works in a hook.

### `memnox config`
`get`, `set` and `list`. Settings: `mode`, `retentionDays`, `failOpen`, `telemetry`.

## Running an agent

### `memnox mcp wrap` / `unwrap`
Repoints every MCP server at the proxy, backing up each config first. `unwrap`
restores byte for byte. `--dry-run` changes nothing.

### `memnox run -- <command>`
Starts an agent with the interceptor directory first on `PATH`, `SHELL` pointed at the
governed shell, and a session id. Hands back the agent's own exit code.

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

### `memnox purge`
Drops history past `retentionDays`. `--dry-run` says what would go.

### `memnox uninstall`
Interceptors, git hooks and wrapping. `--purge` also deletes `~/.memnox`.
