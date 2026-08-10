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

Not enforced, but worth checking for this kind of change (baseline 2026.08.2):
  - authz-check-per-object
      Check that this caller is allowed to touch this particular record — not
      only that they are signed in.
      why: Otherwise someone signed in can change the id in the request and
      read another customer's data.
  - session-cookie-flags
      Set session cookies HttpOnly, Secure, and SameSite, and issue a brand
      new session id whenever someone signs in or changes role.
      why: A session id that survives sign-in still works for whoever planted
      it — and they are now signed in as that person.
  - no-hardcoded-secrets
      Never write a password, key, or token into source. Read it from the
      environment or the secret store.
      why: Deleting the line afterwards does not help — it stays in the git
      history, so the secret has to be replaced.

None of this is a review of your code — Memnox has not read it. The rules
above are your organization's; the checklist ships with Memnox.
```

Two kinds of knowledge, deliberately kept apart:

| | Source | Example |
|---|---|---|
| **Constraints** | your policy files and recorded decisions, quoted verbatim | *"Auth changes need a second pair of eyes."* |
| **Security requirements** | the baseline Memnox ships, keyed by action and target | *"Authorize the specific object being touched."* |

Neither is generated. The security baseline is a lookup table in [`@memnox/content-shield`](../packages/content-shield), so there is no model and no inference. The same input always produces the same requirements in the same order, stamped with `SECURITY_BASELINE_VERSION` so a briefing can be reproduced later.

Asking records nothing and raises no approval. Use `POST /v1/context` from the API, `client.context(request)` from the SDK, or `--json` from the CLI for the structured form.

**When no rule matches, it says so plainly**, reporting *"not endorsed, only ungoverned"*. Silence is the absence of a rule and never approval.

### Let the agent ask on its own

`memnox setup` registers this for you. Restart the client and your agent has two tools:

| Tool | When it calls it |
|---|---|
| `memnox_check_rules` | before writing a file, running a command, deploying, or adding a dependency |
| `memnox_status` | when a call was refused, or the user asks what Memnox is doing |

`memnox mcp` is the server itself, and the client launches it. Add it later, or to another client, with `memnox mcp install`, and remove it with `memnox mcp uninstall <client>`. It never overwrites an existing `memnox` entry in your MCP config. Everything stays local, so there is no account, no API key, and no network call.

## Protect real agents in one command

```bash
memnox protect                      # detects Claude Code and Cursor, installs both
memnox protect claude-code          # or name one explicitly
memnox protect cursor
export MEMNOX_AGENT_TOKEN=mnx_...   # from "memnox agents register"

# Any MCP server: wrap it with the firewall, so tools/call is gated and denied tools are hidden
MEMNOX_AGENT_TOKEN=mnx_... memnox-mcp-firewall --name github -- npx -y @modelcontextprotocol/server-github
```

### Where the token comes from

Nowhere, until you mint it. There is no dashboard, no account, and no file it sits in beforehand — the runtime creates the token at the moment you register an agent, and that is the only moment it exists in readable form.

**Why an agent needs one at all.** Every decision Memnox makes is attributed to a named identity. That is what makes the rest work: a policy can name approvers for *this* agent, the audit trail can say *who* was blocked, trust scores and allow/block counts accumulate per agent, and `memnox agents suspend` can cut off one agent without touching the others. An unidentified caller supports none of that, so the token is not a password protecting a feature — it is the identity the whole decision record hangs on.

The simple path is `memnox setup`. It registers a machine-local agent and writes the token to `~/.memnox/config.json`, directory `0700` and file `0600`, so only your user account can read it. It reuses a token already there instead of minting a second identity every time you run it — two identities for one machine would split that machine's history in half.

**Why a file and not just the environment variable.** An editor launched from the dock or Start menu inherits no shell environment. Your `export MEMNOX_AGENT_TOKEN=...` lives in the terminal that ran it and in nothing else, so an editor hook started by that editor would see no token and silently do nothing. The hook has to be able to read the credential on its own, which means disk. Use the environment variable for terminals, CI, and the MCP firewall; let the file serve the editor.

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
| Held by | the agent, hook, or firewall being governed | you, the operator |
| Used for | `check`, `context`, hooks, the MCP firewall | `agents register`, `suspend`, `rotate`, and other management routes |

A runtime bound to loopback with no admin token configured runs in keyless local mode and treats every management call as admin — convenient on your own machine, which is why `--admin-token` is usually absent from local examples. Bind that same runtime to a routable address without credentials and it refuses to start, rather than serving admin routes to the network.

When you do need to reach a runtime that is remote or authenticated, pass `--url` and `--admin-token`.

Commands resolve credentials in this order, first hit wins:

1. `--token` on the command
2. `MEMNOX_AGENT_TOKEN` in the environment
3. `~/.memnox/config.json`

The order exists so a one-off override never requires editing a file, and so CI can inject a token without one on disk.

| Surface | How it is governed |
|---|---|
| **Claude Code** | `PreToolUse` hook, where exit 2 denies the tool call |
| **Cursor** | Agent hooks (`preToolUse`, `beforeShellExecution`, `beforeMCPExecution`, `afterFileEdit`), because Memnox's three effects map exactly onto Cursor's `allow`, `deny`, and `ask` |
| **Any MCP client** (Windsurf, Zed, Codex, and others) | `@memnox/mcp-firewall` proxies the server, so there is no per-client work |
| **OpenAI Agents SDK, LangGraph, CrewAI, custom loops** | `governTool` and `governTools` from the SDK wrap any function-calling tool registry |

```ts
import { MemnoxClient, governTools } from '@memnox/sdk';

const tools = governTools(memnox, { readFile, writeFile, runShell }, {
  sessionId: runId,
  environment: 'production',
});
// Same signatures and same framework wiring, except each call is now decided before it runs.
```

The runtime has to stay up for a hook to reach it. If you stop it, the hook fails **open**, because a dead runtime should never block development. Governance stops rather than bricking your editor.

## Next

- [Writing policies](policies.md) covers the rules these surfaces enforce.
- [How a decision is made](how-it-works.md) covers what happens after a call is gated.
