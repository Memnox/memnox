---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

A `tools/list` that a server pages with `nextCursor` is read as one listing. Each page was taken for the whole of it, so page two wiped page one from the manifest — its tools lost their annotations and fell back to guessing from the name — and the pin file only ever held the last page, so every new session announced the other page's write tools as having just arrived. The proxy now gathers the pages and hands the listing on once, when the last one comes.
