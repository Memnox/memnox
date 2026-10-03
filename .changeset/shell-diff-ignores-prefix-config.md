---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

Fingerprint checks on shell edits now run where a gitconfig sets `diff.noprefix` or a custom `diff.dstPrefix`, because the diff Memnox reads names its own prefixes instead of inheriting the person's.
