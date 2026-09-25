---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

A session only the hooks see can have a task. `memnox task set "<what the agent is here to do>" --paths src/payments` declares one for the repository you are in, for twelve hours unless `--hours` says otherwise, and any session working there without a task of its own takes it: actions outside the paths count as drift toward the circuit breaker, and a rule matching `scope = out_of_scope` fires. `memnox task show` and `memnox task clear` read and end it. Only `memnox run --task` could declare one before, and a hooked session's id is not something anybody knows.
