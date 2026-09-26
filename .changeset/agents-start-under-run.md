---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

Typing `claude`, `codex` or `gemini` now starts it under `memnox run`, so the egress proxy, the kernel wall and the session's records come with it and nobody has to remember the command. Setup puts a small launcher for each agent CLI this machine has in the same directory as the interceptors. Inside a session it runs the real binary, so a run never starts itself again; `--version`, `--help`, `mcp`, `config`, `update`, `doctor`, `login` and `logout` go straight through; and `MEMNOX_LAUNCH=off` turns it off for one command. `memnox uninstall` removes them with the rest.
