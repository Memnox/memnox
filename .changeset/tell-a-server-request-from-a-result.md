---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

A request the wrapped server starts is no longer read as a tool result. Client and server number their JSON-RPC ids apart, so `sampling/createMessage`, `roots/list`, `elicitation/create` or `ping` could arrive carrying the id of an open `tools/call`. The proxy retired that call, wrote a ledger row with an empty result, framed the server's own request as though it were output, and then let the real result through unrecorded and unframed. Where the colliding id belonged to an open `tools/list`, the tool manifest was wiped.

A server message counts as a response only when it carries no method and does carry a result or an error. Anything the server started goes to the client untouched.
