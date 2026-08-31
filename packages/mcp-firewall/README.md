# @memnox/mcp-firewall

A transparent proxy for MCP servers, in two shapes. Every `tools/call` is checked
against the Memnox runtime before it reaches the server; `tools/list` responses
are filtered so denied tools are never advertised.

- **stdio** (`memnox-mcp-firewall`) wraps a server the client launches locally.
- **remote** (`memnox-mcp-gateway`) fronts a server over HTTP, so an agent running
  somewhere you cannot install anything is still gated.

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

The token is minted, not looked up. Run `memnox setup` to register an agent and
store one, or `memnox agents register --name <name>` against a running runtime to
print one — it is shown once, and `memnox agents rotate <id>` replaces a lost one.
See [Where the token comes from](../../docs/governing-agents.md#where-the-token-comes-from).

The proxy reads it from the environment rather than `~/.memnox/config.json`,
because your MCP client launches it with an `env` block and that is the credential
it gets.

**Without a token the proxy does not gate against policy.** It falls back to
whatever local filtering you configured — `MEMNOX_POLICIES`, the allow/deny
regexes — and if you configured none of that, it forwards every
call untouched. A firewall with no credential is a pipe, so treat a missing token
as an outage rather than a degraded mode.

## Environment

| Variable | Effect |
|---|---|
| `MEMNOX_URL` | runtime base URL |
| `MEMNOX_AGENT_TOKEN` | agent token; without it the proxy runs with static filters only |
| `MEMNOX_TOOLS_ALLOW` | regex — only matching tools are exposed |
| `MEMNOX_TOOLS_DENY` | regex — matching tools are hidden and blocked |
| `MEMNOX_MCP_FAIL_OPEN` | `"true"` forwards calls when the runtime is unreachable |
| `MEMNOX_POLICIES` | policy files evaluated in-process, comma-separated — the only place a call's arguments are read |
| `MEMNOX_AGENT_NAME` | name the local rules match on `agents:`; defaults to `mcp:<server>` |

Tool names reach the runtime as `mcp.<tool_name>`, targeted at the server name, so
a policy can govern them like any other action.

## Arguments stay on this machine

With `MEMNOX_POLICIES` set, the proxy evaluates those rules itself, against the call's
own arguments, before it asks the runtime anything:

```yaml
- name: no-recursive-delete
  match:
    actions: ["mcp.run_shell"]
    arguments:
      command: ["*rm -rf*"]
  decision: { effect: withhold, reason: recursive delete is not an agent action }
```

The runtime is still asked, and the stricter of the two verdicts applies — but what it
receives is the tool name, the server, and the rule ids that matched (`signals`). The
arguments themselves never leave the process.

## Governing an agent you do not host

The stdio proxy only reaches a server the client starts on the same machine. An
agent running on a hosted runner, in someone else's container, or on a managed
platform never passes through it. The gateway moves the gate to where the traffic
is instead of where the developer is:

```bash
MEMNOX_MCP_UPSTREAM=https://mcp.internal/github \
MEMNOX_URL=https://memnox.internal \
memnox-mcp-gateway --name github
```

Callers POST JSON-RPC to `/mcp` and present **their own** agent token:

```
Authorization: Bearer mnx_...
```

That is the one real difference from stdio. The stdio proxy reads a single token
from the environment because it serves one developer; a gateway serves many
agents, so the token arrives per request and the runtime sees the agent that
actually made the call. Attribute a fleet to one gateway credential and the audit
trail says "one agent did everything".

A request with no bearer token is refused **401** — identity fails closed. The
upstream server's own credential, if it needs one, is configured separately via
`MEMNOX_MCP_UPSTREAM_AUTHORIZATION`: a caller's Memnox token authenticates them to
Memnox and is never forwarded to a third party.

| Variable | Effect |
|---|---|
| `MEMNOX_MCP_UPSTREAM` | the MCP server to front (required) |
| `MEMNOX_MCP_UPSTREAM_AUTHORIZATION` | credential for that server, if it needs one |
| `MEMNOX_MCP_GATEWAY_HOST` | bind host (default `127.0.0.1`) |
| `MEMNOX_MCP_GATEWAY_PORT` | bind port (default `8765`) |

The gateway proxies POSTed JSON-RPC, including batches, and reads a reply the
server sends as an event stream. It answers **405** to a `GET`: server-initiated
streams need a connection it does not hold open, and accepting one it would never
feed is worse than refusing it.

Nothing is remembered between requests, so it can run behind a load balancer.

## Two gates, deliberately

`ToolFilter` is enforced at **both** `tools/list` and `tools/call`. Filtering the
listing alone is not a gate: a client can call a tool it was never shown. Denied
by the static filter, the runtime is never consulted.

## Fail closed

If the runtime is unreachable, calls are **blocked**. A firewall that opens when
its policy source disappears is not a firewall. `MEMNOX_MCP_FAIL_OPEN=true`
inverts this for development, and every fail-open decision is logged.

## Layout

| File | Responsibility |
|---|---|
| `json-rpc.ts` | line framing and message parse/serialise |
| `tool-filter.ts` | static allow/deny regexes; deny wins |
| `call-authorizer.ts` | `CallAuthorizer` port; `RuntimeAuthorizer` and `UngovernedAuthorizer` |
| `firewall-session.ts` | routing for one connection over a `FirewallChannel` |
| `firewall.ts` | spawns the child process and wires stdio to a session |
| `firewall-args.ts` | splits `--name <server> -- <command…>`; null means print usage |
| `cli.ts` | the stdio binary: parse, print usage or start. No logic of its own |
| `event-stream.ts` | pulls JSON-RPC payloads out of an SSE body |
| `upstream-server.ts` | `UpstreamServer` port; the HTTP implementation |
| `gateway-exchange.ts` | one POST, gated: runs a `FirewallSession` over request/response |
| `mcp-gateway.ts` | the HTTP server; owns sockets and nothing else |
| `gateway-cli.ts` | the remote binary |

`FirewallSession` holds no process and no socket — it is driven directly in tests
with a recording channel. `McpFirewall` owns the child process and nothing else;
`McpGateway` owns sockets and nothing else.

Both transports share one gate. stdio gives the session two independent streams;
HTTP gives it a request and its reply, so `GatewayExchange` adapts one onto the
other — post what the session approved, feed the replies back through the same
session — rather than reimplementing the gate for a second transport.

## Denials are results, not errors

A blocked call returns an `isError` **result**, not a JSON-RPC protocol error, so
the model reads the denial reason and can explain or reroute. A protocol error
would look like a crash.
