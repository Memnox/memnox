---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

One malformed request no longer ends the egress proxy. Both handlers ran with no `catch` and nothing registers an `unhandledRejection`, so a rejection took the process down — and that process can be the daemon. A mangled `Proxy-Authorization` threw `URIError` and an `https://` absolute-form request threw `TypeError: Protocol "https:" not supported`, either of which any local process could send.

Each is answered now and the server serves the next request. A CONNECT authority is read through `URL`, so `[2001:db8::1]:443` tunnels instead of resolving to host `[2001` on port `NaN`, and an IPv6 host in absolute form has its brackets taken off before it is forwarded. An absolute-form request whose scheme this proxy cannot speak is refused with the reason, and an upstream error after the head has gone out ends the response rather than writing the head twice.
