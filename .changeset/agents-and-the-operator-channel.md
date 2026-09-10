---
'memnox': minor
---

`memnox agents`, and a channel an operator can reach an agent through.

`VISION.md` section 10 is the agent workforce and section 22 is why it is hard: five
agents with five security models, and on a VPS at three in the morning nobody can walk
to any of their terminals. This machine could already scan itself and report what it
found, but there was no command named for agents and no way for a person to say
anything to one.

- **`memnox agents discover`** scans this machine, keeps the scan, and reports it
  through the same pass a sync uses rather than growing a second path that sends a
  census. Two ways to report one scan is one of them drifting, and the cursor that
  stops a scan being sent twice already lives there.
- **`memnox agents list` and `status`** read the kept scan and never take a fresh one.
  A scan starts every MCP server it finds, and listing is the thing somebody runs twice
  in a row: making it the expensive one is how it stops being run. `status` names the
  file that proved each surface rather than counting them, because a count says how
  much an agent reaches and the path says who granted it.
- **All of it is about this machine.** The console answers what the whole fleet runs,
  because only something holding every machine's reports can. Answering that from here
  would mean widening what a machine credential reaches, and how narrow that is
  is exactly what `machine-credential.test.ts` exists to hold.
- **`memnox agents control`** collects what an operator has said and acknowledges it.
  The seam still runs one way: nothing dials this machine, it asks, the same way it
  asks for a bundle. There is no connection held open waiting to be told something.
- **A command is not a verdict, and nothing here may treat one as one.** What comes
  back is a person's own words for whoever is at the agent. What the agent does next is
  decided here, locally, against the rules already on disk. If a message ever starts
  being read as permission then the gate has moved onto the network, and the local
  first claim goes with it.
- **Shown, then acknowledged, in that order.** A turn is handed over once, so
  acknowledging first would lose it on any failure between the two. The worst case is a
  receipt nobody recorded rather than an instruction nobody saw, and a receipt that
  fails to land never fails the message it was about.
