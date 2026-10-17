---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

A scan reads every MCP server a JSON config declares. Remote servers — an entry with a `url` and no launch line, the commonest kind now — were skipped, though the TOML and YAML readers already recorded them. Claude Desktop's servers were read only from the macOS path, so on Linux none were found. And servers added inside a Claude Code project, under `projects["<path>"].mcpServers` in `.claude.json`, were never read. All three are read now, so a scan stops under-reporting what an agent can reach.
