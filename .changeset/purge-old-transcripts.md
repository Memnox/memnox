---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

`memnox purge` deletes transcripts past the retention window. `trace` has always said they share the ledger's retention, and nothing ever deleted one, so raw agent output under `~/.memnox/transcripts/` was kept for good. A transcript last written before the cutoff now goes with everything else, `purge --dry-run` counts it, and a session whose `memnox run` is still alive keeps its transcript whatever its age.
