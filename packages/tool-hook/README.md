# @memnox/tool-hook

The seam that holds an agent's **own** tools.

`@memnox/mcp-firewall` governs what an agent reaches through an MCP server. This
governs what it does directly — reading a file, writing one, running a shell
command, fetching a URL — which is most of what a coding agent does. It runs as a
`PreToolUse` hook: the host writes the pending tool call on stdin, and the hook
answers before the tool runs.

A verdict nobody is obliged to ask for is advice. This is the seam that makes an
agent that was never written to consult anything ask anyway.

## Using it

```
memnox hooks install     # registers it in ~/.claude/settings.json
memnox hooks status      # what it sees, and what it cannot
memnox hooks uninstall   # removes only ours; every other hook is left alone
```

`memnox setup` installs it too. Pass `--no-hooks` to skip that.

## What it rules on

| Tool | Action |
|---|---|
| `Read`, `Glob`, `Grep` | `filesystem.read` |
| `Write`, `Edit`, `NotebookEdit` | `file.write` |
| `Bash` | `shell.execute` |
| `WebFetch`, `WebSearch` | `http.request` |
| `Task` | `agent.spawn` |

The action names what the tool does to the resource, never what kind of file it
guesses the resource is: `Edit` writes to a file, and whether that file is code is
an inference this seam does not make.

Anything else is left to the host's own permission flow.

## The three answers

- **allow** — nothing is written, and the host's ordinary permission flow runs.
  The seam never answers `allow` to the host, because that would skip a prompt the
  person would otherwise have seen. It can hold an action back or hand it to
  somebody; it cannot widen authority.
- **withhold** — `permissionDecision: "deny"`, carrying the rule's alternative.
  An agent told only no abandons the task; one told what to use instead finishes it.
- **escalate** — `permissionDecision: "ask"`. Locally the approver is the person at
  the keyboard, and the reason names the `memnox approvals resolve` command.

## Where it gets its rules

The environment first, then what `memnox setup` wrote to `~/.memnox`:

| | |
|---|---|
| `MEMNOX_POLICIES` | policy files evaluated in-process, comma-separated |
| `MEMNOX_URL`, `MEMNOX_AGENT_TOKEN` | the runtime, which alone resolves an alternative and raises an approval |
| `MEMNOX_AGENT_NAME` | the name local rules match on `agents:` |
| `MEMNOX_HOOK_FAIL_OPEN` | `"true"` to allow when the runtime is unreachable. Default: fail closed |

An agent launched from a desktop icon inherits no shell, so a seam that only read
the environment would install cleanly and then govern nothing. Falling back to disk
is what makes `memnox setup` enough.

Local rules are evaluated first and see the tool's arguments; they never leave this
machine. A local refusal never becomes a network request. When both gates answer,
the stricter one wins.

## Blind to

- the model's reasoning
- anything a shell command does after it is allowed to start
- MCP tool calls, which the MCP proxy seam holds instead
- any call it cannot answer within its timeout, which the agent then runs ungoverned

A governed agent with an unwatched side channel is worse than an ungoverned one,
because somebody believes it. `memnox hooks status` prints this list.
