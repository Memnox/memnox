---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

`memnox report --session <id>` adds up one session, `last` for the latest: files read and changed, reads and changes in each system outside this machine, what was held and what was stopped. `memnox why` shows the task declared for the session and the three steps before the decision. `memnox replay` puts what changed on the machine, from an hour before the session until it ended, in order beside what the session did, so a server that gained a tool sits right before the agent calling it.

`memnox explain <server>` shows what each tool would meet under the rules in force and which rule decides it, and `memnox explain <agent>` shows each system the agent reaches with its reads and its changes counted as allowed, asked, refused and covered by no rule. A server that disappears from an agent's config is now a notice, because what relied on it will fail, and a new server's notice says how many of its tools read, write and delete.
