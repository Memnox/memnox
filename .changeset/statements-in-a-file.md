---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

`psql -f query.sql` is ruled on by what the file holds, so a file of selects is a read under a read-only rule and one that drops a table is destructive. A file over half a megabyte, or one that will not read, leaves the command the write it was before.
