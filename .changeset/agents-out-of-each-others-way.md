---
"@memnox/interceptors": minor
"@memnox/core": minor
"@memnox/proxy": minor
"memnox": minor
---

Two agents on two machines stop writing the same lines without either being told. An edit takes its lease from inside the agent through a hook, in Claude Code, Codex, Cursor, Gemini CLI and Windsurf, and the hook reads the lines and the function the edit is about to change, so two sessions in one file only meet where their edits do. Anything with no hook of its own, which is every other agent and a person in their own editor, is watched instead: the daemon claims the lines a saved file changed a moment after the save, says plainly that it could not stop that save, and tells the other side.

Work that writes no path is claimed too. Posting the message, opening the issue, closing the pull request: the MCP proxy and the shell wrappers ask one register before the work goes out, so an agent here meets an agent there on the same issue rather than doing it twice. A claim lasts as long as the call and is let go the moment it returns.

A refusal now names which lines are held, who holds them, whether they have gone quiet and when they free up, and it ends on the one thing a person can type, `memnox lock --free <id>`, which frees another machine's hold with the reason kept on the record. Where a person is at the session, Claude Code asks them in its own permission prompt instead of refusing.

A running session is told while it works. The same hook collects what was said to that session at every pause and hands it to the agent beside the tool result, and the proxy does the same for an agent with no hooks, so the agent that got somewhere first hears about the collision in its own session. What it did is sent within a couple of seconds rather than on the next heartbeat.

`memnox setup` wraps the MCP servers as part of the guided run and writes into each wrapped line which agent it belongs to, so a refusal names Claude Code or Cursor rather than "an agent".
