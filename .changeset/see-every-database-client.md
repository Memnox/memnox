---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

A drop-in database client is ruled on like the client it replaces. `mysql -e "DROP DATABASE prod"` was destructive and `mariadb -e` with the same statement was an ordinary shell line, because the statement grammar was keyed on four binary names. `mariadb` and `mycli` now read a statement the way `mysql` does, and `pgcli` the way `psql` does, each keeping its own name in the action so a rule can still name one client.

`redis-cli` has a table of its own, matched whatever case the command is typed in, since the protocol ignores it. Destructive: `FLUSHALL`, `FLUSHDB`, `DEL`, `UNLINK`. Write: `SET`, `CONFIG SET`, and an interactive session. Read: `GET`, `KEYS`, `SCAN`, `INFO`.
