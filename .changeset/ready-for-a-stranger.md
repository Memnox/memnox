---
'memnox': minor
'@memnox/core': minor
---

Say what is stopping work, and reach an agent nothing started from a terminal

`memnox doctor` gains a check for the four things that stop work without a rule saying
so — a paused session, an exhausted allowance, an unanswered question, a held path.
None of them is a policy decision, so none appears in `memnox why`, and until now the
honest answer to "my agent stopped and nothing says why" was a shrug.

`memnox env` prints the environment systemd, Docker or cron has to set for itself.
`PATH` is expanded for the two that run no shell, and the screen says the expansion is
this shell's, because one generated on a laptop and pasted onto a server names binaries
that are not there.

`memnox uninstall` now clears held and paused state, which would otherwise govern the
next install without appearing anywhere.
