---
'memnox': minor
'@memnox/core': minor
---

A write says which lines and which function it touches, worked out at the moment
it happens.

A lease could only ever say the path, so two agents in one file collided even
when one was rewriting the imports and the other a function four hundred lines
down. The control plane accepts a narrower claim, but only an agent that had
been told to declare one ever sent it, which is no agent nobody has updated.

- **Read off the change, not declared.** Git already computes both halves and
  puts them in the hunk header: `@@ -6 +6,2 @@ export function retryCharge(` is
  the lines and the enclosing function in one line of output. No parser, no
  syntax tree, no dependency, and it covers every language git ships a pattern
  for.
- **On the write path, so it is bounded.** `shared-leases.ts` already states the
  budget next door: an interceptor runs on every write and a slow control plane
  must not be felt. The diff is one file, abandoned after 400ms, and read only
  once the local register has agreed, so a session about to be refused by a
  collision on this machine never pays for it.
- **Every failure is the whole file.** Not a repository, a new file with nothing
  committed, a language git has no context pattern for, git missing from the
  path, a rewrite too large to read, or a diff that ran long. All of them answer
  nothing, and nothing has always meant the whole file to a lease. This can fail
  to narrow a claim. It cannot lose a collision.
- **Only ever within one named file.** A lease is usually taken on the directory
  a write lands in, and a directory's diff spans several files. Narrowing that
  by symbol would be a loosening change rather than a refinement: two sessions
  editing different files under it each name the functions in their own, the two
  sets never meet, and both proceed where both used to wait. So a region is used
  only where the diff covers exactly the path that was asked about, and anything
  wider claims the lot.
- **The name beats the row.** A line number is a position and goes stale the
  moment anybody inserts above it; `retryCharge` is the same function before and
  after. Where both are known the control plane compares the names, so two
  agents whose stored ranges have drifted are still told apart correctly.
