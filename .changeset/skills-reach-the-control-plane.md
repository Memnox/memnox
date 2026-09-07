---
'memnox': minor
---

A self-taught skill is held on the machine that wrote it, and nobody is sitting at that
machine.

`memnox skills` has always found them, held them and printed them to a terminal.
`VISION.md` `I.4` asks for a self-taught capability to be treated like a deployment, and
the person deciding how much autonomy an agent gets is looking at a console. Until now
that half did not exist: the local screen was the whole feature.

- **`pushSkills` sends them on the heartbeat**, as `finding.raised` under the kind
  `skill.changed`. Sent as a finding rather than a kind of its own because the ingest
  door already understands one: it gets a row, a place in an inbox, and
  `finding.resolved` as the way it is cleared. That last one is the point.
  `finding.resolved` is refused at the door, so a self-improving agent can report the
  skill it just wrote and cannot mark it reviewed. The agent proposes; a person accepts.
- **The skill's text never leaves the machine.** What travels is a name, the agent whose
  directory holds it, the tools it names and a digest. A control plane holding its
  customers' agent instructions would be keeping the thing it is meant to be governing.
- **Cursored on content, not on a moment.** The census and the findings read a scan that
  was kept and can ask whether its `takenAt` has been sent. Skills are reviewed as they
  are found, so there is no such moment, and a time cursor would show one row for a skill
  widened twice inside one sync interval. The digest moves even when there is nothing to
  report, so a machine whose agents have taught themselves nothing costs one comparison
  per sync rather than reconsidering an empty set for ever.
