---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

A wrapped MCP server that dies under a working agent is said on the proxy's stderr and kept as a `config.drift.server-down` row with its exit code. One that ends cleanly, or that the agent itself stopped, is not news. `memnox doctor --servers` lists the servers that stopped in the last day above the ones it starts and asks.
