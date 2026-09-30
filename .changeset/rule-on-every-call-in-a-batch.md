---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

Every call in a JSON-RPC batch is ruled on. MCP permits batching, and the proxy cast whatever arrived to a single message: an array has no `method`, so it matched no rule and went straight to the wrapped server. A `tools/call` sent inside a batch ran with no verdict, no ledger row and no result framing, and its reply came back unframed because nothing was waiting for it.

A batch is now split and each element goes through the same path a lone message does. One denied call does not carry the rest with it: the allowed ones travel on as a batch, the denied ones come back as a batch of refusals, and each call is a row of its own. A batched reply is split the same way, so a result is framed and recorded against the call it answers.

A denied notification is no longer answered. JSON-RPC says a notification receives no reply, and a refusal was going back with no id on it. The refusal is still recorded; only the reply is gone.

An item inside a batch that is not a request object is answered with `Invalid Request` rather than read as one. A `null` threw where the proxy had nothing to catch it, which took the session down, and a call nested in an inner array carried no `method`, so it was forwarded with no ruling at all.
