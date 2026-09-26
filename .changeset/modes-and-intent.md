---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

`memnox mode investigate` lets every agent on this machine read anything, files, repositories, logs, databases, APIs and MCP tools, and refuses every change outside the machine, pushes, and writes outside the workspace, with a way forward that says to report what it found. `memnox mode autonomous` lets the work through, edits, tests, commits, pushes and pull requests, and stops at moving money, deploying, handing out authority, deleting outside the machine and any change in an environment named like production. `memnox mode off` goes back to your own rules. A mode is a set of ordinary rules in `~/.memnox/mode.policies.toml`, so `why` and `policy test` explain it like any other.

A task can be declared as an investigation, with `memnox task set "..." --intent investigate` or `memnox run --investigate`, and a change outside the machine is then refused with the ask quoted back. The summary at the end of a session now says how many changes landed outside the machine and how many a person approved.
