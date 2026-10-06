---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

A tool result is read for instruction-shaped content wherever that content sits. `textOfResult` looked only at a content block's own `text`, so an injection placed in an embedded resource's `text` or in `structuredContent` was never quoted, never put the session under suspicion, and was recorded as fewer bytes than it carried. Both are now read, along with the text beside them, and the framing is unchanged: the content still survives whole inside the quotation rather than being stripped.
