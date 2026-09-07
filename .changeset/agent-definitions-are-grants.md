---
'@memnox/core': minor
'memnox': minor
---

A persona installed into an agent's directory is a capability grant, and nothing here
was reading one.

- **`~/.claude/agents` and seven directories like it are now scanned.** Skill discovery
  read `.claude/skills` and four siblings; the `agents/` directory beside each of them
  was scanned by nothing. It holds definitions somebody installed, and a public roster
  is a `git clone` and one script away — three hundred markdown files fanned out across
  every harness on the machine, overwriting what was there without keeping a copy.
- **The grant is in the header, and an absent key is the widest one there is.** On
  Claude Code, Qwen and ZCode a definition with no `tools:` line inherits every tool in
  the session: the shell, writes, and every connected MCP server. Nothing here parsed
  markdown frontmatter at all, so a `tools: Bash, Write` was invisible and its absence
  more so. `memnox scan` now counts them — *"122 installed into claude-code, 114 of
  them declare no tools, so each inherits every tool in the session"* — and `memnox
  skills` says which of the two it is per file. Where a vendor does not document that
  meaning it reads "declares no tools this reads", never a guess.
- **What a file declares and what it names stay two claims.** A grant is read out of
  the header and stated as fact. A tool named in prose is a verb-table match, and is
  still reported as evidence rather than proof. Folding them into one number would turn
  the checkable half into the guessable one.
- **A roster that arrives at once is held, as one row.** A new skill is deliberately not
  held: an agent that cannot write its first one is an agent somebody switches this off
  to use. That reasoning does not cover twelve definitions appearing in one directory
  between two scans, which is an install and not somebody's own work. It is held, and
  shown once with a count rather than three hundred times.
- **A grant that was removed is a widening.** A definition that named four tools and now
  names none reads as a small edit and is the largest change a file can make, so the
  accepted record carries the grant and `WIDENED` compares it.
- **`memnox watch` reports one arriving, and stops spinning.** `~` is watched and every
  cycle saved a snapshot under `~/.memnox`, so the watcher woke on its own write,
  rescanned, wrote again, and the interval stopped meaning anything. It ignores what
  this program wrote itself now. It also woke on `~/.claude/agents` and then looked at
  nothing, which is worse than not watching.
