---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

`memnox run --transcript` masks credentials on the way to disk. The agent's output was teed straight into the log file, so a token in an error message or an `aws configure` echo landed in clear text under `~/.memnox/transcripts/` — and `memnox claims` and `memnox trace` read it back onto a screen long after the session ended. The terminal still sees the stream exactly as the agent printed it; only the copy that stays is rewritten.

Masking is by whole lines, because a chunk boundary falls wherever the pipe happened to break and half a token matches no rule. A character whose bytes arrive in two chunks is held until it is complete, and a last line the agent never terminated is kept and masked rather than dropped. The transcript is also flushed before `run` returns, so its final lines are no longer cut off by the process exiting first.
