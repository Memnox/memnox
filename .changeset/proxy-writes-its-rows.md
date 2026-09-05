---
'@memnox/interceptors': patch
'@memnox/core': patch
'@memnox/proxy': patch
'memnox': patch
---

The MCP proxy writes to the ledger again. It ruled on every `tools/call` and appended
nothing — the reporter was dropped when the packages were consolidated, leaving an
empty function under a comment claiming every call reached the ledger — so `memnox
timeline`, `why` and `trace` showed the shell and git seams and not the one most
agents actually use.

One call is one row, written when the outcome is known: a refusal as it is refused, an
allowed call when its result returns, carrying the size of what came back and whether
it held instruction-shaped content. The row names the rule that decided, so `why` no
longer answers "none matched" about a call a rule had just refused. Arguments never
reach the row; a digest does.

Opening the ledger is the proxy CLI's job rather than the firewall's, for the same
reason loading the gate is — a test that passes no sink writes nothing to the
developer's own history.

`SESSION_VAR` moves to `@memnox/core`. Three packages were spelling `MEMNOX_SESSION`
themselves, and a typo in any of them would have scattered one agent's session
silently.
