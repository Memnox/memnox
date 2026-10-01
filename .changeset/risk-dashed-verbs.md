---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

Risk classification now splits actions on dashes and camelCase, so verb table actions like `gh.repo-delete` and MCP tools like `deleteRepo` are rated high. `rm`, `remove`, `unpublish` and `terminate` now count as destructive, and `view`, `describe` and `show` as reads.
