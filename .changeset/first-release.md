---
'@memnox/interceptors': patch
'@memnox/core': patch
'@memnox/proxy': patch
'memnox': patch
---

First release: 0.1.0. Every binary the CLI installs now ships from the `memnox`
package, `mcp wrap` refuses when the proxy is not on PATH, and the interceptor reads
the binary it stands for from the argument the wrapper passes rather than its own path.
