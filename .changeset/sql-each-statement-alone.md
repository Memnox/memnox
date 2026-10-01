---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

A database command is now ruled on by its most dangerous statement, so a WHERE in one statement no longer hides an unbounded DELETE or UPDATE in the next.
