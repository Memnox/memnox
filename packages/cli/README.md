# memnox

The `memnox` command: run the runtime, manage policies, and inspect the audit
trail.

```bash
npx memnox setup     # policies, agent token, running runtime
npx memnox status    # is it on, what is in force, what would it have stopped
```

`setup` is the local install: policies, an agent token, the MCP server, and a
runtime with every deterministic guard on — shell indirection, taint, decision
memory, behavior, trust, and verification. The first run observes rather than
blocks. `--no-mcp`, `--no-serve` and `--no-detect` opt out of the individual
steps.

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
| `describe <action> [target]` | everything the organization attaches to one action, and what else its rules reach |
| `plan [file]` | rule on a whole run before it starts (`--from-session` plans one already on record) |
| `test` | fire the dangerous-capability suite at your own gate and report what got through |
| `drift` | where the stated rules and the actual history disagree |
| `trace [eventId]` | the evidence behind one recorded decision, link by link |
| `approve <id>` / `deny <id>` | resolve a pending approval (`--by` defaults to `$USER`) |
| `simulate [file]` | replay real history through candidate rules |
| `reload` | re-read policy files without restarting the runtime |
| `audit` / `audit verify` | recent decisions; verify the hash chain |
| `replay <sessionId>` | every decision in one agent session, in order |
| `agents` | register, list, suspend, activate, rotate |
| `approvals` | list pending (bare), status, resolve, break-glass override, flow health |
| `memory` | record team decisions as machine-checkable constraints |
| `policy` | version, simulate, packs, install, ui |
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
llm-provider-option.ts    LlmProviderFactory for the BYOK commands
commands/                 one <name>.command.ts per command
```

A command that needs something beyond output and HTTP takes it as a **defaulted
third parameter**, so `buildProgram` stays a plain list and a test supplies only
what that one command touches:

| Command | Collaborator |
|---|---|
| `serve` | `ServerLauncher` — defaults to `startServer` |
| `explain`, `draft`, `intent` | `LlmProviderFactory` — defaults to BYOK providers |
| `test` | a session-id factory, so a recorded run is reproducible in a test |

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
