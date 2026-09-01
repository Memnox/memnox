# memnox

The `memnox` command: run the runtime, manage policies, and inspect the audit
trail.

```bash
npx memnox setup     # policies, agent token, running runtime
npx memnox status    # is it on, what is in force, what would it have stopped
```

`setup` is the local install: policies, an agent token, the MCP server, and a
running runtime. The first run observes rather than blocks. `--no-mcp`,
`--no-serve` and `--no-detect` opt out of the individual steps.

Most commands need no connection flags: the agent token and runtime URL come from
`MEMNOX_AGENT_TOKEN`/`MEMNOX_URL` or the config `memnox setup` wrote to
`~/.memnox/config.json`. An explicit flag always wins.

## Commands

| Command | What it does |
|---|---|
| `discover` | what can act on this machine, and what it can reach. No account, no network. |
| `doctor` | what on this machine is risky, why, and the one change that closes each |
| `harden` | close what the doctor found, reversibly — proposed by default |
| `hooks` | govern an agent's own file, shell and network tools |
| `setup` | policies, an agent identity, and a running runtime — in one command |
| `init` | create a starter policy file in the current directory |
| `serve` | start the Memnox runtime gateway |
| `stop` | stop the background runtime that "memnox setup" started |
| `status` | is the runtime up, which rules are in force, what is waiting |
| `login` | sign this machine in to your organization control plane |
| `logout` | forget the control plane credential on this machine |
| `whoami` | which runtime and which organization this machine is talking to |
| `queue` | everything waiting on a person, in one place |
| `timeline` | what agents and sources did across the workspace, newest first |
| `pull` | fetch your organization's rules and apply them to this machine |
| `validate [file]` | validate a YAML policy file |
| `check [action] [target]` | ask the runtime for a decision on one action (exit 2 = needs approval, 3 = withheld) |
| `test` | fire real dangerous actions at your own gate and report what it stops (exit 1 = something got through) |
| `audit` | show the most recent action decisions |
| `agents` | manage agent identities |
| `approvals` | review pending approvals |
| `approve <id>` | grant a pending approval |
| `deny <id>` | deny a pending approval |
| `mcp` | run Memnox as an MCP server so agents can ask before they act |
| `replay <sessionId>` | replay every decision in one agent session, in order |
| `why [decisionId]` | why one decision came out the way it did, a line per link, from the record |
| `rules <action> [target]` | what governs this action, and what else those rules reach |
| `coverage` | how much of what your agents actually do is governed, and what is not |
| `learn` | what your agents actually used, what they never needed, and the rules that follow |
| `kill <agentId>` | stop one agent everywhere: suspend its credential, revoke its leases, close its seams |
| `quarantine <agentId>` | hold one agent read-only, so it stays debuggable rather than dead |
| `panic` | raise every environment to enforce and stop issuing capabilities |
| `policy` | inspect, version, simulate, and compose policy sets |
| `simulate [file]` | replay real history through candidate rules before shipping them |
| `reload` | re-read the policy files without restarting the runtime |

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
| `test` | a session-id factory, so a recorded run is reproducible in a test |

`console.*` appears in exactly two places: `ConsoleOutput` and `index.ts`.
Everywhere else writes through `context.out`.

`out.line()` is the payload a caller may pipe; `out.note()` is commentary that
must stay out of that pipe (it goes to stderr). `memnox learn` and
`memnox audit` depend on that split.

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
