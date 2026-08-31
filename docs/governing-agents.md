# Governing your agents

Two things happen here. Agents ask what the rules are before they act, and every surface they run on is gated whether or not they ask.

> **Agent** here means the AI tool being governed — Claude Code, Cursor, an MCP server, your own script — not a person. [concepts.md](concepts.md) defines that and the other terms below.

## Ask before you act

A gate refuses an action after an agent has already committed to it. The cheaper move is to answer the question first, meaning *what governs this?*, so the agent carries the rules into its work instead of meeting them as a refusal.

```bash
memnox context file.write 'src/app/(auth)/login/page.tsx'
```

```
Memnox constraints for "file.write src/app/(auth)/login/page.tsx"
This action would need human approval before it proceeds (risk: medium).
Next: ask security-team to approve before this proceeds.

Rules that apply — these decide whether this proceeds:
  - auth-code-review — your policy, requires approval
      Auth and session code changes need a second pair of eyes.
      approvers: security-team
  - decision-memory — signal, requires approval
      conflicts with team decision "Session handling stays in one place"
      (platform-team): new auth surfaces reuse the shared session module.
      approvers: security-team

None of this is a judgement on the work itself — the rules above are your
organization’s, quoted as declared.
```

Every line is a **constraint** this organization declared, and the label says where it came from:

| Label | Source | Example |
|---|---|---|
| **your policy** | a rule in your policy files, quoted verbatim | *"Auth changes need a second pair of eyes."* |
| **signal** | a deterministic advisor — recorded decisions, taint, behavior, verification | *"Conflicts with a decision the team recorded."* |

Neither is generated. There is no model and no inference in a briefing: the same input always produces the same constraints, in the same order and the same words, so a briefing can be cached, diffed, and reproduced later.

Asking records nothing and raises no approval. Use `POST /v1/context` from the API, `client.context(request)` from the SDK, or `--json` from the CLI for the structured form.

**When no rule matches, it says so plainly**, reporting *"not endorsed, only ungoverned"*. Silence is the absence of a rule and never approval.

### Let the agent ask on its own

`memnox setup` registers this for you. Restart the client and your agent has two tools:

| Tool | When it calls it |
|---|---|
| `memnox_check_rules` | before writing a file, running a command, deploying, or adding a dependency |
| `memnox_status` | when a call was refused, or the user asks what Memnox is doing |

`memnox mcp` is the server itself, and the client launches it. Add it later, or to another client, with `memnox mcp install`, and remove it with `memnox mcp uninstall <client>`. It never overwrites an existing `memnox` entry in your MCP config. Everything stays local, so there is no account, no API key, and no network call.

## Gate what the agent actually calls

Asking is advisory: an agent that never calls `memnox_check_rules` is not governed by it. Enforcement has to sit where the call is made, and the firewall is the one that needs no cooperation from the agent at all.

```bash
# Any MCP server: wrap it with the firewall, so every tools/call is decided first
MEMNOX_AGENT_TOKEN=mnx_... memnox-mcp-firewall --name github -- npx -y @modelcontextprotocol/server-github
```

The agent points at the firewall instead of the server and sees the same tools, except that every `tools/call` becomes a decision before it reaches upstream. `MEMNOX_TOOLS_ALLOW` and `MEMNOX_TOOLS_DENY` take regexes that hide tools from the listing as well — both are applied at `tools/call` too, since a client can call a tool it was never shown.

### Where the token comes from

Nowhere, until you mint it. There is no dashboard, no account, and no file it sits in beforehand — the runtime creates the token at the moment you register an agent, and that is the only moment it exists in readable form.

**Why an agent needs one at all.** Every decision Memnox makes is attributed to a named identity. That is what makes the rest work: a policy can name approvers for *this* agent, the audit trail can say *who* was withheld, allow and withhold counts accumulate per agent, and `memnox agents suspend` can cut off one agent without touching the others. An unidentified caller supports none of that, so the token is not a password protecting a feature — it is the identity the whole decision record hangs on.

The simple path is `memnox setup`. It registers a machine-local agent and writes the token to `~/.memnox/config.json`, directory `0700` and file `0600`, so only your user account can read it. It reuses a token already there instead of minting a second identity every time you run it — two identities for one machine would split that machine's history in half.

**Why a file and not just the environment variable.** An MCP client launched from the dock or Start menu inherits no shell environment. Your `export MEMNOX_AGENT_TOKEN=...` lives in the terminal that ran it and in nothing else, so a server that client spawns would see no token and could answer nothing. It has to be able to read the credential on its own, which means disk. Use the environment variable for terminals, CI, and the MCP firewall; let the file serve a GUI client.

To mint one by hand instead:

```bash
memnox serve                                            # default http://127.0.0.1:7466
memnox agents register --name claude-code --kind claude-code
```

**Why the runtime has to be up first.** `agents register` is not a local operation that writes a file. It is an HTTP call to the runtime, which is the thing that owns agent identities and mints their credentials. No runtime listening, no token — the command has nobody to ask.

**Why it is shown exactly once.** The token is 32 random bytes with an `mnx_` prefix. The runtime keeps only its SHA-256 hash, which lets it recognize a token you present without ever being able to reproduce one. Same reason a well-built system cannot email you your old password: the original is genuinely gone. So copy it when it appears. If you lose it, you do not recover it — you replace it with `memnox agents rotate <id>`, which mints a new token and stops honoring the old one. Rotation is also the right move if a token leaks into a log, a screenshot, or a commit.

`--kind` labels what sort of agent this is — `claude-code`, `cursor`, `openai-agent`, `mcp`, or `custom` (the default) — so policies and the audit trail can tell them apart. `--name` is yours to choose; make it something you would recognize in an audit line a month from now.

**Two different credentials, easy to confuse.** They answer different questions and are not interchangeable:

| | `MEMNOX_AGENT_TOKEN` | `--admin-token` |
|---|---|---|
| Answers | *which agent is asking for this decision?* | *who is allowed to administer this runtime?* |
| Held by | the agent, SDK caller, or firewall being governed | you, the operator |
| Used for | `check`, `context`, the MCP server and firewall | `agents register`, `suspend`, `rotate`, and other management routes |

A runtime bound to loopback with no admin token configured runs in keyless local mode and treats every management call as admin — convenient on your own machine, which is why `--admin-token` is usually absent from local examples. Bind that same runtime to a routable address without credentials and it refuses to start, rather than serving admin routes to the network.

When you do need to reach a runtime that is remote or authenticated, pass `--url` and `--admin-token`.

Commands resolve credentials in this order, first hit wins:

1. `--token` on the command
2. `MEMNOX_AGENT_TOKEN` in the environment
3. `~/.memnox/config.json`

The order exists so a one-off override never requires editing a file, and so CI can inject a token without one on disk.

| Surface | How it is governed |
|---|---|
| **Any MCP client** (Claude Code, Cursor, Windsurf, Zed, Codex, and others) | `@memnox/mcp-firewall` proxies the server it calls, so every `tools/call` is decided and there is no per-client work |
| **A shell, a script, a pipeline step** | `memnox check <action> [target]` prints the verdict, the risk, and the rules that produced it |
| **OpenAI Agents SDK, LangGraph, CrewAI, custom loops** | `governTool` and `governTools` from the SDK wrap any function-calling tool registry |
| **Any other service** | `POST /v1/authorize` answers 200 or 403, from whatever language it is written in |

```ts
import { MemnoxClient, governTools } from '@memnox/sdk';

const tools = governTools(memnox, { readFile, writeFile, runShell }, {
  sessionId: runId,
  environment: 'production',
});
// Same signatures and same framework wiring, except each call is now decided before it runs.
```

The runtime has to stay up for any of these to reach it. If you stop it, the MCP firewall fails **closed** and refuses the call, because a firewall that fails open is not a firewall. `MEMNOX_MCP_FAIL_OPEN=true` inverts that, deliberately and out loud.

## Next

- [Writing policies](policies.md) covers the rules these surfaces enforce.
- [How a decision is made](how-it-works.md) covers what happens after a call is gated.
