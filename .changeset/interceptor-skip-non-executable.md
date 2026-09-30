---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

The interceptor now skips a directory or a file without the execute bit that is named like the binary it wraps, and keeps walking PATH as a shell would, so an earlier stray entry no longer makes the command fail silently.
