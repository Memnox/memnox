---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

A milestone now keeps the small files git ignores, so a rewind puts back an ignored config or key file the agent changed or deleted. Only files of a megabyte or less are kept, at most two hundred, and a wholly ignored directory such as `node_modules` or `dist` is skipped without being walked. A rewind still never deletes an ignored file created since the milestone, and the person's own index never sees any of them. The contents are kept in this repository's `.git` under `refs/memnox/`, which no ordinary push sends anywhere.
