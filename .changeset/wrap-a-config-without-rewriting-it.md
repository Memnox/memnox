---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

`mcp wrap` governs a config with comments in it, and rewrites only the entries it wraps. It read configs with `JSON.parse`, so a VS Code or Cline file carrying a single `//` comment was skipped and its servers were never put behind the proxy. And it wrote the whole file back at two spaces, so a four-space file came back with every line changed. Configs are now read as JSONC and edited by span, the way `agents onboard` already edits them: comments, indentation and every untouched line stay exactly as they were. `mcp unwrap` puts back the entry's own original text where the backup still holds it, so a wrap and an unwrap return the bytes they started from, an inline `args` array included.
