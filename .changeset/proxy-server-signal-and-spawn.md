---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

A wrapped MCP server killed by a signal is now reported as down and the proxy exits 128 plus the signal number, so a SIGKILL reads as 137 rather than a clean exit. A server command that cannot start is said and exits 127, and a broken pipe to a dying server no longer crashes the proxy, since the next call is refused as server gone.
