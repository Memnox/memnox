---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

The MCP proxy no longer corrupts an emoji, accented letter or other multi-byte character that a pipe splits across two chunks, so tool arguments and results reach the other side unchanged.
