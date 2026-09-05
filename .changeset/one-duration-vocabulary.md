---
'@memnox/interceptors': patch
'@memnox/core': patch
'@memnox/proxy': patch
'memnox': patch
---

Every flag naming a stretch of time now reads the same shapes. `--since`, `--for`,
`--usage`, `--from-usage` and `--days` had five parsers with five error sentences
between them, so `memnox freeze --for 2d` was refused while `memnox timeline
--since 2d` was not. One parser answers all of them, and a bare number is read in
whatever the flag is about.

`@memnox/proxy` and `@memnox/interceptors` no longer declare the five seam
binaries. `memnox` ships them, as it always did; declaring the same names in three
packages linked each of them more than once for anybody who installed two.
