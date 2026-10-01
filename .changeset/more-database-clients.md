---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

A statement passed to mariadb, mycli or pgcli is now read the way mysql and psql read it, so `mariadb -e "DROP DATABASE x"` is a destructive drop. redis-cli has its own verb table, matched in any case, so `FLUSHALL` and `flushall` are both destructive.
