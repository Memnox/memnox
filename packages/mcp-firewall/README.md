# @memnox/mcp-firewall

A transparent stdio proxy for MCP servers. Every `tools/call` is checked against
the Memnox runtime before it reaches the server; `tools/list` responses are
filtered so denied tools are never advertised.

## Using it

Wrap any MCP server in your client config:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@memnox/mcp-firewall", "--name", "github", "--",
               "npx", "-y", "@modelcontextprotocol/server-github"],
      "env": { "MEMNOX_AGENT_TOKEN": "mnx_..." }
    }
  }
}
```

The client sees an ordinary MCP server. Everything it calls goes through policy
first.

## Environment

| Variable | Effect |
|---|---|
| `MEMNOX_URL` | runtime base URL |
| `MEMNOX_AGENT_TOKEN` | agent token; without it the proxy runs with static filters only |
| `MEMNOX_TOOLS_ALLOW` | regex — only matching tools are exposed |
| `MEMNOX_TOOLS_DENY` | regex — matching tools are hidden and blocked |
| `MEMNOX_MCP_FAIL_OPEN` | `"true"` forwards calls when the runtime is unreachable |

Tool names reach the runtime as `mcp.<tool_name>`, targeted at the server name, so
a policy can govern them like any other action.

## Two gates, deliberately

`ToolFilter` is enforced at **both** `tools/list` and `tools/call`. Filtering the
listing alone is not a gate: a client can call a tool it was never shown. Denied
by the static filter, the runtime is never consulted.

## Fail closed

If the runtime is unreachable, calls are **blocked**. A firewall that opens when
its policy source disappears is not a firewall. `MEMNOX_MCP_FAIL_OPEN=true`
inverts this for development, and every fail-open decision is logged.

This is the opposite of the editor hooks in `@memnox/cli`, which fail *open* —
a hook that bricks your editor gets uninstalled, and an uninstalled hook enforces
nothing. A proxy has no such problem.

## Layout

| File | Responsibility |
|---|---|
| `json-rpc.ts` | line framing and message parse/serialise |
| `tool-filter.ts` | static allow/deny regexes; deny wins |
| `call-authorizer.ts` | `CallAuthorizer` port; `RuntimeAuthorizer` and `UngovernedAuthorizer` |
| `firewall-session.ts` | routing for one connection over a `FirewallChannel` |
| `firewall.ts` | spawns the child process and wires stdio to a session |
| `firewall-args.ts` | splits `--name <server> -- <command…>`; null means print usage |
| `cli.ts` | the binary: parse, print usage or start. No logic of its own |

`FirewallSession` holds no process and no socket — it is driven directly in tests
with a recording channel. `McpFirewall` owns the child process and nothing else.

## Denials are results, not errors

A blocked call returns an `isError` **result**, not a JSON-RPC protocol error, so
the model reads the denial reason and can explain or reroute. A protocol error
would look like a crash.
