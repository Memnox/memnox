---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

The MCP proxy no longer mistakes a request the server starts, such as `sampling/createMessage` or `ping`, for the result of an open tool call or tool listing that happens to share its id. The request now reaches the agent untouched, and the real result that follows is still recorded and framed, so a colliding id can no longer wipe the tool manifest.
