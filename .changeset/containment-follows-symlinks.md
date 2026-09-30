---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

A write through a symlink inside the repository that points outside it now asks first, because the repository boundary compares where a path really lands rather than how it is spelled. A link that points elsewhere inside the repository still counts as inside.
