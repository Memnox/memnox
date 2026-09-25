---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

On Linux, the Landlock wall of `memnox run --untrusted` now leaves the repository's own `.env` files out of what it grants, to read and to write, since a Landlock write grant reads as well. They are found by name up to three directories down, never inside `node_modules`, `.git` or build output, and `.env.example`, `.env.sample` and `.env.template` stay granted.
