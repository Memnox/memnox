---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

The MCP proxy honours `notifications/cancelled`. A call held for a person was still sent to the server on a late yes, after the agent had given up on it — running something nobody was waiting for any more. And a call the server dropped after a cancellation, which MCP allows, stayed open for good and never got a ledger row. A cancelled call that is still held now sends nothing and owes no reply; one already sent is closed with a row that says it was cancelled. The notification itself is always forwarded, so the server can stop work it had begun.
