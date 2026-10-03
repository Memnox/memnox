---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

`memnox report --since` and `memnox next --since` now read `30m`, `2h`, `7d` and an ISO timestamp the way `timeline` does, so `--since 2h` covers two hours rather than two days. A value neither command can read is refused with the same message `timeline` gives, rather than quietly falling back to a default window.
