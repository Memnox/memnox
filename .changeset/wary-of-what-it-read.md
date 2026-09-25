---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

A session becomes wary of what it read from any tool, not only an MCP one. When a fetched page, a file or a command's output addresses the model, such as "ignore previous instructions", the after-tool hook marks the session and what goes outward is asked about for the window, as an MCP result saying it already did. Memnox's own session tools never mark it.

The circuit breaker now counts actions outside the task `memnox run --task --paths` declared, so its scope-drift trip can fire. Nothing reported them before, and the counter it reads stayed at zero.
