---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

`timeline --limit`, `purge --days`, `budget set --limit` and `task set --hours` now refuse `abc`, `0` and `-1` with a plain sentence naming the flag, rather than sending `LIMIT NaN` to SQLite, writing a budget nobody could count against, or declaring a task that has already expired.
