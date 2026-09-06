---
'@memnox/interceptors': minor
'@memnox/core': minor
'memnox': minor
---

Answer "what can I safely let my agent do next?"

Three match fields parsed, validated and then never fired because nothing set them:
`scope`, `roles` and the claim checker. `memnox run --task/--paths/--role` declares
them, so a rule about drift or about which agent may deploy now bites.

On top of that: a circuit breaker that watches outcomes and holds a session that is
failing the same way, getting nowhere, exploding past its own estimate or drifting out
of its task; `memnox paused`/`resume` to see and lift a hold; `memnox budget` for how
much an agent may do in a window; `memnox next` for what you could stop being asked
about; `memnox autopilot` for the boundary as the engine actually decides it; `memnox
skills` to hold a self-written skill whose reach has grown; `memnox report` for what
was redone; `memnox claims` for what was said against what was recorded; and grouped
approvals, so five similar calls are one decision.

Counts, never scores. No spend figure, because nothing here can price a model call.
