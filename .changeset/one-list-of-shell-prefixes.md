---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

A prefix in front of an interpreter no longer hides it. The shell normalizer and the resolver each kept their own list of prefixes and interpreters, and a third copy read `timeout` alone, so they disagreed: `doas python3 -c x`, `stdbuf -o0 bash -c x`, `ionice -c3 node -e x`, `sudo -u root python3 -c x` and `timeout 10 python3 -c x` were all missed by the resolver, and the paths an interpreter on that line could write were not counted as reached. `timeout -s KILL 5 bash -c x` was misread by the normalizer too, which took `KILL` for the duration. One walk through the prefixes now serves both, from one list.
