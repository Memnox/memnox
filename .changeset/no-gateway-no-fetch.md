---
'@memnox/proxy': patch
---

Remove `HttpUpstreamServer` and the SSE reader behind it. The remote gateway they were
written for was never wired: no binary, no command, and no caller anywhere — the tsup
entry pointing at its CLI named a file that does not exist. What it left behind was the
only `fetch` in the shipped code, which is a poor thing to leave in a tool whose claim
is that nothing goes anywhere.

Nothing in the runtime now originates a network request. The two remaining sockets are
the daemon's unix socket and the egress proxy bound to loopback, which forwards the
agent's own traffic after the gate has ruled on it.
