---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

A rule's pattern can now leave things out: one starting with `!` takes matches back out, and `{workspace}` stands for the directory the agent is working in. So a rule can ask about every host but the ones a project talks to, and refuse a write anywhere but the workspace while the workspace goes through untouched, which an allow rule could never do because an ask or a deny beats it. A request that names no target or no working directory cannot be shown to be excluded, so the rule still applies to it. The hook now reports the working directory for file edits too.

The generated rule about credential files leaves `.env.example`, `.env.sample` and `.env.template` readable, since a template holds names and no values. Claude Code's native permissions and the kernel wall cannot express an exclusion, so they stay the wider of the two.
