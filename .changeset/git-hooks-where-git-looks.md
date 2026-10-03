---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

`memnox protect --hooks` now asks git where its hooks live, so it installs into linked worktrees and submodules instead of failing, and says it skipped rather than claiming success when `core.hooksPath` points at a hook framework such as Husky. The installed hook also quotes its binary path, so a path containing a space, `$` or quote still runs.
