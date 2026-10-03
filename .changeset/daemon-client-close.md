---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

An intercepted command now keeps its ledger row and exits with its real status when the daemon closes the connection without replying. A final reply the daemon sends without a trailing newline is read rather than dropped.
