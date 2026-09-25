---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

The MCP proxy classifies a call by what the server said about its tool when it listed it, so a `readOnlyHint` or a `destructiveHint` decides over a name that says something else, and a rule about changes reads the server's own word. Before the first listing it goes by the name, as it did.

The first time an agent reaches a host through the egress proxy is a `network.first-destination` row, so a timeline shows when it began, and `memnox explain <agent>` lists the hosts it has reached with how often and since when.
