# @memnox/proxy

A transparent proxy for stdio MCP servers. Every `tools/call` is ruled on in this
process before it reaches the server, and `tools/list` responses are filtered so a
denied tool is never advertised in the first place.

Ships as the `memnox-mcp-proxy` binary. You do not normally run it by hand —
`memnox mcp wrap` points your agent's config at it, and `memnox mcp unwrap` puts
the config back, byte for byte.

```sh
memnox-mcp-proxy --name github -- npx -y @modelcontextprotocol/server-github
```

## What it does, in order

1. `tools/list` from the server is filtered through `ToolFilter`. A tool the
   patterns deny is removed from the answer, so the model never learns it exists.
2. `tools/call` goes to a `CallAuthorizer` — the local gate, reading the same rule
   files everything else reads. Allow passes through untouched; ask and deny are
   answered to the client as an MCP error naming the rule and the alternative.
3. A result coming back is inspected for instruction-shaped content and **quoted**
   rather than removed. Silently editing a payload is a bug the agent cannot see;
   a quoted one is visible and carries no authority.

## What it cannot see

Declared in `firewall.constants.ts` rather than left to be discovered: the model's
reasoning, anything the agent does without a tool call, and whatever the wrapped
server does on its own once a call is allowed through. A governed agent with an
unwatched side channel is worse than an ungoverned one, so the blind spots are a
constant in the code.

**Proxied calls are not written to the ledger.** The reporter that did this was
dropped when the packages were consolidated. `memnox timeline` therefore shows the
shell and git seams and not this one — see `docs/threat-model.md`.

## Environment

| Variable | Meaning |
|---|---|
| `MEMNOX_POLICIES` | rule files, comma-separated |
| `MEMNOX_TOOLS_ALLOW` | regex — only matching tools are exposed |
| `MEMNOX_TOOLS_DENY` | regex — matching tools are hidden and denied |

With no rule file configured the proxy still runs: the static tool filters become
the only gate, and it says so rather than pretending to govern.

Apache-2.0.
