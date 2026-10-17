---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

The egress proxy forwards a request body as the bytes that were sent. It decoded the body to text and wrote that text upstream, so a gzip upload, an image or a protobuf gained replacement characters on the way through. And a body over the 1 MB this seam reads was dropped while the request still went, carrying a `content-length` that promised bytes and an upstream that got none, without ever being inspected for a secret.

The raw bytes now go upstream untouched, and only a copy is decoded for inspection. A body past the limit is refused rather than sent unread, and the ruling says it was too large to inspect.
