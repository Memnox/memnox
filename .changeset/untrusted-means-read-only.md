---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

Inside an untrusted repository, a cloned one or one run with `--untrusted`, an MCP tool that changes something is refused rather than asked about, while reading through it still goes, and the repository's own `.env` files are refused while `.env.example`, `.env.sample` and `.env.template` stay readable. On macOS the kernel wall of `memnox run --untrusted` refuses those key files too, so a binary the agent runs cannot read them either. A CLI that reaches out still asks, as it did.
