---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

A shell command that writes several files takes a lease on each of them, so `touch a b`, `sed -i` across two directories or a redirect alongside them is withheld when another agent holds any of the paths, not only the first. Two leases one process took in the same millisecond shared an id and the second overwrote the first on disk; the id now carries the path.
