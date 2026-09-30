---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

A Codex patch that moves a file now has its destination checked as well as its source, so renaming a file out of the repository is held at the boundary rather than slipping through.
