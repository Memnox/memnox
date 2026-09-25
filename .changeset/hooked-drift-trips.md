---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

A session only the hooks see now trips the circuit breaker's scope drift. An allowed action outside the task declared for it, by `memnox task set` or `memnox run --task`, is reported to the daemon as drift and nothing else, so the breaker counts it toward its threshold without the action being charged to a budget or counted as work done.
