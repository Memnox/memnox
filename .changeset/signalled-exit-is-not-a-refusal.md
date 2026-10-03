---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

A command killed by any signal now exits 128 plus the signal number through `memnox-shell` and the interceptors, so SIGKILL reads as 137 and SIGSEGV as 139 rather than as a refusal (77) or a plain failure (1). A command that cannot be started exits 127 when it is missing and 126 when it is not executable, and the interceptor now says why on stderr.
