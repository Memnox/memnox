# Operating

Three questions you will be asked and cannot currently answer: how much is covered,
what stops an agent, and what can you hand an auditor.

## How much is actually governed

```bash
memnox coverage
```

```
MEMNOX COVERAGE

  62% of what your agents do is governed

  actions           18/22 distinct actions have a rule
  seams             3/4 enforcing
  machines          39/40 enforcing

  Weighted by risk, times seam coverage, times machine coverage. An agent
  governed on one seam of four is not a governed agent.

Nobody has ruled on these
  repository.force_push
  cloud.write

Your seams cannot see
  the model's reasoning
  in-editor edits
```

**The formula matters.** Distinct actions governed over distinct actions seen, weighted
by risk, times seam coverage, times install coverage. A read loop firing ten thousand
times is one governed action, and without the weighting it would drown out every
irreversible action in the company — reporting ninety-nine percent while every
production delete goes ungoverned.

Two things the number refuses to hide:

- **An agent governed on one seam of four is not a governed agent.** Seam coverage is a
  multiplier, not a footnote.
- **Thirty-nine machines enforcing and one not is a hole**, not a rounding error.

If no seam is installed, coverage is zero however many rules you have written. A verdict
nobody is obliged to ask for is advice, and rules alone govern nothing:

```
  Nothing is intercepting, so nothing has to ask. Rules alone govern nothing.
  Install one with memnox harden --apply, or memnox mcp install.
```

Every seam also declares what it **cannot** see. A governed agent with an unwatched side
channel is worse than an ungoverned one, because somebody believes it is watched.

## Stopping one agent

```bash
memnox kill <agentId> --reason "it reached production" --by you
```

Revokes its leases, closes its seams, cancels its pending work — in one recorded action.

```
KILL  con_90d8aa44

  leases revoked      2
  seams closed        1
  machines reached    39

  NOT REACHED — this is not finished:
    laptop-asleep

  Re-run when those machines are back. Until then, they are ungoverned.
```

**A killed agent on a laptop that is asleep is not killed yet.** The action records
which installs it reached and which it did not, and the command exits non-zero on a
partial containment, so a script cannot treat it as finished. A kill reporting success
while one machine is offline would be the worst possible lie this product could tell.

`memnox quarantine <agentId>` restricts rather than refuses: read-only, no capability
issuance, which keeps an agent debuggable instead of dead.

`memnox panic` raises every environment to enforce and stops issuing capabilities. It
needs a reason, an author, and **a restore path** — it is refused without one, because a
control with no way back is not a control:

```bash
memnox panic --reason "incident 928" --by you --restore "memnox policy rollback"
```

## Two agents, one piece of work

Once more than one agent is at work, the collision is in the ledger before it is in a
merge conflict, because both agents act through seams that recorded what they touched.

```bash
memnox collisions
```

```
⚠ CONCURRENT WORK

  src/payments.ts

    claude-code     writing   2026-08-31T11:50:00.000Z
    codex           writing   2026-08-31T11:56:00.000Z

  One file, two agents, no shared awareness.

⚠ DUPLICATE EFFORT

  claude-code     oauth-refresh
  codex           token-rotation

  same files    src/auth/session.ts
                src/auth/tokens.ts
  since         2026-08-28T09:00:00.000Z
```

Two readers in one file is a normal Tuesday, so a collision needs at least one writer.
Duplicated effort needs more than one shared file over a longer window, because one is a
coincidence and a report full of coincidences is a report nobody reads.

**Limit.** It reports the collision. It does not open the diff and decide which agent is
right — that is code review, a different product with a different buyer, and it is out of
scope permanently.

## What is not reported

- **No estimated loss, and no risk exposure in currency.** Both are underivable, and
  publishing one tells a security reader the rest is marketing.
- **No hours saved or value delivered in our voice.** Actions, interventions, retries
  and spend are measured; anything modelled takes its rate from you and is labelled as
  yours.
- **Nothing about this product's own usage.** Every number here is about your
  organization's behaviour. Feature usage belongs in an internal dashboard nobody sells.

## Next

- [Learning from behaviour](learning-from-behaviour.md) — where the coverage gaps become rules.
- [How it works](how-it-works.md) — what happens inside one decision.
