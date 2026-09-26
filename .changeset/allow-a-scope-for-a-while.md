---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

`memnox allow "railway.*" --env staging --for 30m --reason "reproducing the retry bug"` allows a scope for a while, so an agent working inside it is not asked at every step: one approval rather than thirty. It is narrowed by action, environment, target and agent, it only ever answers a question a rule would have asked and never overrules a refusal, it ends on its own and at most eight hours out, and every decision it makes says who allowed it and until when. `memnox allow --list` shows what is in force and `memnox allow --revoke <id>` ends one now.
