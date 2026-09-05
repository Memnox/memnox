---
'@memnox/interceptors': minor
'@memnox/core': minor
'@memnox/proxy': minor
'memnox': minor
---

`memnox login` now takes no arguments. A machine has no credential when it asks, so a
workspace it named would be one nothing could check it against; whoever approves the code
is signed in to exactly one, and that is where the machine lands. It is printed on
enrolment, so an answer nobody expected is visible rather than silent.

`memnox sync` does a full pass — pull the rules, send what happened, report the heartbeat
— and the daemon runs the same pass every minute, backing off to fifteen while the
control plane is unreachable. Pull always precedes push: a machine just given a stricter
rule set should be governed by it before it reports anything it did under the old one.

Actions are sent in ed25519-signed batches over the exact bytes posted, keyed on the
event id the control plane deduplicates on — so a crash between "posted" and "recorded"
costs a comparison rather than a lost row, and the cursor is an optimisation rather than
the correctness. A revoked machine stops syncing; everything else backs off and keeps
trying, because the ordinary reason a laptop is unreachable is a closed lid.
