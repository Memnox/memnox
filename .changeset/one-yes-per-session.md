---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

"Allow for this session" now holds for the rest of the session. The grant was kept in the memory of the process that heard the answer, and every hook and shell wrapper is its own process, so the next call was asked again. Grants are kept on disk under `~/.memnox/grants`, and cover the action the question named, so `gh.pr-view` allowed once for the session covers the next pull request viewed as well. A web request's grant covers that host and an MCP call's covers that server's tool. A delete is only ever granted for the exact call.

The second yes to the same action in one session is the last one asked for, whether it was given in the terminal, from the workspace, or in the agent's own permission prompt, where the tool running is read as the yes. A delete is never learned this way, and a new session starts over.
