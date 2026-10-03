---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

`memnox-shell` and the command interceptors now pass SIGTERM and SIGHUP on to the command they started, so an agent that stops a timed out call stops the real shell, `git` or `npm` with it. The wrapper then exits 143 for SIGTERM, as a shell would.
