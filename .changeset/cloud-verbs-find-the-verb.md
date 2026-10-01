---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

The gcloud and az verb tables now find list, describe, show and delete wherever the command group puts them, and name secret reads and `gcloud storage rm`. A resource named like a verb no longer turns a delete into a read.
