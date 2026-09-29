---
'@memnox/core': patch
'@memnox/cli': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
---

Reject malformed policy time windows and UTC offsets outside -840 to 840 minutes so invalid time-scoped rules fail validation instead of crashing or silently not matching.
