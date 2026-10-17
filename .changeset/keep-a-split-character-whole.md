---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

The MCP proxy no longer corrupts a character that a pipe splits across two chunks. Each chunk was decoded on its own, so an emoji, a CJK character or an accented letter straddling the cut became two replacement characters, and because `JSON.parse` still succeeded the damaged text was forwarded as though nothing had changed — tool arguments on the way out, results on the way back. Each direction now keeps its own decoder, which holds the incomplete bytes until the rest arrive.
