---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

An agent another agent started is held to that agent's rules as well as its own, so a child never does what its parent may not. Codex launched from Claude Code's shell, or an agent started under a nested `memnox run`, is ruled as itself and as every agent above it, the strictest answer winning, and a refusal that came from a parent names it. The chain is read from what the parent hands down, its own marker and the `MEMNOX_PARENT_AGENTS` that `memnox run` writes. A sub-agent Claude Code runs inside its own session was already ruled as Claude Code.
