---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

The MCP proxy now gathers every page of a paginated tool listing before it records the tools, so a server that lists in pages keeps its tool hints and no longer reports tools from another page as newly arrived in every session.
