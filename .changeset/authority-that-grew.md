---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

The daemon now says when an agent's authority grew between two of its passes: an agent that can now change a system with nobody asked, where before it could only read it; a CLI newly logged in on the machine, which any agent with a shell can then use; and a CLI whose credential now names something like production, such as a kubectl context called `prod-eu-1`. Each is a notice and a `config.drift.authority` row, the first pass only records what there is, and authority that narrowed is not news.
