---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

Every file Memnox installs a hook into is a file only a person may write. Claude Code's settings were protected and the other four were not, so Cursor could edit `~/.cursor/hooks.json` and take the policy hook straight back out — and the same for Codex, Gemini CLI and Windsurf. A write to any of them is refused now, and so is a shell line that names one.

`AGENT_HOOK_FILES` is the one list, exported from `@memnox/core` and imported by the installer that writes the hooks as well as by the guard that protects them, so a file gaining a hook cannot be left unguarded by the two drifting apart.
