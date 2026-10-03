---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

A held `rm` now reads as a recursive, forced delete however the flags are spelled, so `rm -r -f`, `rm -rfv` and `rm --recursive --force` say the same thing as `rm -rf`.
