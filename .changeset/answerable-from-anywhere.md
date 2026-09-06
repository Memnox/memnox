---
'@memnox/interceptors': minor
'@memnox/core': minor
'memnox': minor
---

An `ask` rule holds for a person instead of denying

Every seam took an optional hold service and none of them ever built one, so an `ask`
rule reached "nobody could be asked, so it was denied" — on a laptop with somebody
sitting at it and on a VPS at three in the morning alike. That made `ask` a synonym for
`deny` and left no way to run an agent unattended at all.

The question is now written down and answered from wherever an answer turns up: the
terminal, a second terminal running `memnox approve`, or the workspace, whose answer
comes back on the machine's next heartbeat. Names only cross the wire.

Leases consult the workspace too, so two machines on one repository stop being a coin
flip, and a budget can be counted across the fleet rather than once per machine. Both
degrade rather than block when the control plane cannot be reached.
