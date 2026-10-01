---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

`memnox-shell -- <command>` now quotes each argument before ruling on it, so `rm -rf "my dir"` is ruled and checkpointed as one target and `echo "a; rm x"` stays one command instead of two.
