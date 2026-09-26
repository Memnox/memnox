---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

A session's task is now what the person typed, without anybody declaring one. Each prompt is kept as the session's task, so `why` quotes the ask, and a prompt that reads as an investigation, "investigate why the payments failed", "look into the staging failure", or anything that says "do not change anything", holds the session to reading: a change outside this machine is refused and the agent is told so up front. A prompt that asks for a fix is not an investigation, a task a person declared with `memnox task set` or `memnox run --task` is never replaced by one read from a prompt, and it is read by its words, never by a model.

A session only the hooks saw now shows its summary line as a desktop notice when it ends, since nobody is watching its terminal by then.
