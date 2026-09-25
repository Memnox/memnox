---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

A server that grows a tool that changes things is caught the moment it lists it. The MCP proxy keeps what each server listed last time under `~/.memnox/pins`, and a listing with a new tool that writes, deletes or sends, or an old one that started to, is said on the proxy's stderr and kept as a `config.drift.new-write-tool` row naming the tools and which of them no rule covers. `replay` shows it beside what the session did. The daemon still never starts a server; the proxy already talks to it.
