---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

Docker commands that remove containers, images, volumes and networks, prune the system with `--all`, or bring compose down with its volumes are now destructive rather than unknown. `run`, `exec`, `compose up`, `stop`, `kill`, `tag` and `login` are named writes, and `login` is tagged as touching secrets.
