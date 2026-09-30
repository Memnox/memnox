---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

`memnox-mcp-proxy` now refuses `--name` or `--agent` given no value and names the flag, rather than taking the next flag as the value and misreading everything after it.
