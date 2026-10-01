---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

The vercel verb table now covers a bare `vercel`, `env pull`, `env ls`, `rm`, `remove`, `promote`, `rollback`, `redeploy`, `alias` and `dns rm`, so none of them resolve to unknown any more.
