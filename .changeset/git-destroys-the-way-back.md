---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

Git commands that destroy the way back, such as `reflog expire`, `stash clear` and `push --delete`, are now destructive, and a `+main` refspec resolves to the same force push action as `--force`.
