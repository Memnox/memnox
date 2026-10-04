---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

A milestone is kept before every command that destroys work, not only `rm`, `mv` and four git subcommands. `shred`, `unlink` and `rmdir` were already destructive to the seam that rules on them and invisible to the one that keeps a tree first, so an agent was asked about them and then ran them with nothing to rewind to. `truncate` to a size that is not an extension, `git checkout --force`, `git switch --discard-changes`, `git switch -f`, `git stash drop` and `git stash clear` join them, and `--force` is now accepted wherever `-f` already was.

A dropped stash is not in the tree a milestone keeps, so that row marks when the work went rather than offering to bring it back.
