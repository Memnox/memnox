---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

A scan now counts `PASSWORD`, `PGPASSWORD`, `MYSQL_PWD` and `SECRET_KEY_BASE` as credentials and reads `export NAME=` lines by their name, so `echo $PGPASSWORD` is recorded as an environment read. It also looks in `.envrc`, `.env.staging`, `.env.test` and `.env.production.local`.
