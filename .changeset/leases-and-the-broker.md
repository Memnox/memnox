---
'@memnox/interceptors': minor
'@memnox/core': minor
'memnox': minor
---

Leases: two agents in one repository stop being a coin flip

`memnox lock` holds a path while you work on it, and the seams take one on their own
before a write. It locks paths and never meaning, it never blocks a read, every lease
expires, a dead holder is reclaimed rather than waited on, and a wait is always bounded
— a lease that could hang an agent for ever is worse than the collision it prevents.
