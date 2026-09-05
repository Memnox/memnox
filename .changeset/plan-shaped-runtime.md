---
'@memnox/interceptors': minor
'@memnox/core': minor
'@memnox/proxy': minor
'memnox': minor
---

Rebuild the runtime around the build plan: four packages (`core`, `cli`, `proxy`,
`interceptors`), the plan's command names, and `allow / ask / deny` as the three
effects. The HTTP runtime and its SDK are gone — every seam now evaluates in process.
