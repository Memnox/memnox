# memnox

The command. It reads what can act on your machine, decides what it may do, and
records what happened — with no account, no key and no network.

```sh
npx memnox
```

## The three questions

| Question | Command |
|---|---|
| What can act here, and what can it reach? | `memnox scan` |
| What changed since last time? | `memnox diff`, `memnox watch` |
| May this action proceed? | `memnox protect`, `memnox policy test`, `memnox check` |

And afterwards: `memnox timeline` for what happened, `memnox why` for why it was
decided that way, `memnox trace` for one action end to end.

Every command and flag is in [docs/commands.md](../../docs/commands.md).

## What ships in this package

The `memnox` binary plus the five seam binaries, because npm exposes the bins of
the package you installed and not those of its dependencies. Without them,
`memnox mcp wrap` would point every MCP server at a binary you do not have.

| Binary | From |
|---|---|
| `memnox` | this package |
| `memnox-mcp-proxy` | `@memnox/proxy` |
| `memnox-shell`, `memnox-intercept`, `memnox-git-credential`, `memnox-egress` | `@memnox/interceptors` |

## How a command is put together

A command file holds the flag table, argument shape-checking, and the dispatch to
what each flag does. Anything longer than that lives beside it: `src/scan/` holds
what `scan` renders, `src/protect/` holds what each of `protect`'s flags does, and
anything a second command would want is a module in `src/` — `duration.ts`,
`event-store.ts`, `memnox-paths.ts`.

Everything a command needs from outside itself arrives in a `CliContext`, so no
command reaches for `console` and a test needs no terminal. Collaborators that
would read `$HOME` or spawn a process are injected with a default, which is why
the suite never touches the developer's own machine.

Node 20 or newer, macOS or Linux. On Windows, run it inside WSL —
[ADR 0001](../../docs/adr/0001-windows-support.md) says why.

Apache-2.0.
