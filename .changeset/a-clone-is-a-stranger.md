---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

A repository an agent clones starts on probation, because it is a stranger's code. From the `git clone` on, work inside it is contained as `memnox run --untrusted` contains a session: outward and destructive actions ask, and writes outside it ask, without anybody having to remember the flag. `memnox repo list` shows what is on probation and `memnox repo trust <path>` ends it once somebody has looked. It ends by itself after seven days, as an agent's or a server's does.
