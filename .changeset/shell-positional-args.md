---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

The governed shell now passes the words after a `-c` line on to the real shell, so `$0`, `$1` and `"$@"` arrive as they were given, and a `--` after the line no longer switches it into the argv form. Options that take a value, such as `-o pipefail`, keep their value instead of it being run as a script.
