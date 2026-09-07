---
'memnox': patch
---

`memnox login` sent people to a page that does not exist.

The approval URL was built from the `--url` base, which names an API. On every
deployment that has a console those are two different origins, so `memnox login`
opened `https://api.memnox.com/device?code=…` — a host that serves no pages —
and the browser showed a 404 with the code stranded in the address bar.

The control plane names the page now, in the `verificationUri` and
`verificationUriComplete` of its answer, which are the RFC 8628 fields of those
names and the only ones that can be right: only a deployment knows where its own
console is. The old derivation stays as the fallback for a control plane too old
to say, where it is wrong in exactly the way it always was rather than a
regression, and correct where console and API do share an origin.
