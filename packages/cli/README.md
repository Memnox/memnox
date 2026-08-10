# memnox

The `memnox` command: run the runtime, manage policies, inspect the audit trail,
and install editor hooks.

```bash
npx memnox setup     # policies, agent token, editor hooks, running runtime
npx memnox status    # is it on, what is in force, what would it have stopped
```

`setup` is the local install: policies, an agent token, editor hooks, the MCP server, and
a runtime with every deterministic guard on — content shield, shell indirection, taint,
decision memory, behavior, trust, verification, and dependencies. The first run observes
rather than blocks. `--no-hook`, `--no-mcp`, `--no-serve` and `--no-detect` opt out of the
individual steps.

Most commands need no connection flags: the agent token and runtime URL come from
`MEMNOX_AGENT_TOKEN`/`MEMNOX_URL` or the config `memnox setup` wrote to
`~/.memnox/config.json`. An explicit flag always wins.

## Commands

| Command | What it does |
|---|---|
| `init` | write a starter policy file |
| `ui` (`policy ui`) | edit the policy file in a local browser UI instead of YAML |
| `serve` | start the runtime gateway |
| `validate [file]` | check a policy file and list what it enforces |
| `status` | is the runtime up, which rules are in force, what is waiting |
| `context <action> [target]` | what governs an action — ask before doing it |
| `mcp` / `mcp install` | run Memnox as an MCP server; register it with a client |
| `check [action] [target]` | ask for a decision on one action |
| `approve <id>` / `deny <id>` | resolve a pending approval (`--by` defaults to `$USER`) |
| `simulate [file]` | replay real history through candidate rules |
| `reload` | re-read policy files without restarting the runtime |
| `audit` / `audit verify` | recent decisions; verify the hash chain |
| `replay <sessionId>` | every decision in one agent session, in order |
| `agents` | register, list, suspend, activate, rotate |
| `approvals` | list pending (bare), status, resolve, break-glass override, flow health |
| `memory` | record team decisions as machine-checkable constraints |
| `policy` | version, simulate, packs, install, ui |
| `graph` | build the import graph; explain a file's blast radius |
| `graphify` | install/build/use [Graphify](https://github.com/Graphify-Labs/graphify) for deeper reachability |
| `ci` | scan a diff for secrets and PII in CI |
| `hook` | editor hook entry point (reads a tool call on stdin) |
| `protect` | install the hook into Claude Code and/or Cursor |
| `explain` | plain-language explanation of a decision (BYOK LLM) |
| `draft` | draft policy YAML from a sentence (BYOK LLM) |
| `intent` | expand a goal into the actions it would take |
| `insights` | patterns across the audit history |
| `report` | compliance evidence export |

Run `memnox <command> --help` for flags.

## Architecture

Commands are thin. Everything ambient — stdout and the HTTP client — arrives as a
`CliContext`, so a command body is reachable in a test without spawning a process
or opening a socket:

```
index.ts                  composition root: builds the real context, parses argv
program.ts                buildProgram(context) — the command tree
cli-context.ts            CliContext: output + client factory
cli-output.ts             CliOutput port; ConsoleOutput and RecordedOutput
git-diff.ts               DiffSource port for `ci`
hook-host.ts              HookHost port for `hook` — stdin, streams, exit, env
editor-hook-installer.ts  writes editor configs under a given home directory
llm-provider-option.ts    LlmProviderFactory for the BYOK commands
commands/                 one <name>.command.ts per command
```

A command that needs something beyond output and HTTP takes it as a **defaulted
third parameter**, so `buildProgram` stays a plain list and a test supplies only
what that one command touches:

| Command | Collaborator |
|---|---|
| `ci` | `DiffSource` — defaults to `git diff` |
| `serve` | `ServerLauncher` — defaults to `startServer` |
| `protect` | `EditorHookInstaller` — defaults to `$HOME` |
| `hook` | `HookHost` — defaults to the real process streams |
| `explain`, `draft`, `intent` | `LlmProviderFactory` — defaults to BYOK providers |

`console.*` appears in exactly two places: `ConsoleOutput` and `index.ts`.
Everywhere else writes through `context.out`.

`out.line()` is the payload a caller may pipe; `out.note()` is commentary that
must stay out of that pipe (it goes to stderr). `memnox memory digest` and
`memnox draft` depend on that split.

## Testing a command

```ts
const runtime = new FakeRuntime().on('POST', '/v1/actions/check', decision);
const { out } = await runCli(['check', '--token', 't', '--action', 'x'], runtime);
expect(out.text).toContain('Decision : BLOCK');
```

`runCli` builds the real command tree against a recording output and a stubbed
transport, so the assertion covers the actual command body and the actual SDK
call — see `test/cli-harness.ts`.

## Adding a command

1. Write `src/commands/<name>.command.ts` exporting
   `register<Name>Command(program: Command, context: CliContext): void`.
2. Register it in `src/program.ts`.
3. Add `test/<name>-command.test.ts` driving it through `runCli`.

Commands never call `console` and never construct a `MemnoxClient` — use
`context.out` and `context.client(options)`.
