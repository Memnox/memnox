---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

A session is summed up when it ends, without anybody asking. `memnox run` prints one line after the agent exits: actions, files read and changed, reads and changes in the busiest systems, and what was stopped, with the command that shows the rest. A session only the hooks saw leaves the same line as a `session.summary` row when it ends, filed with the config rows so no count of agent work includes it.
