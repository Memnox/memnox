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

## Who is out there

```bash
memnox census --tracked 281
```

```
AI WORKFORCE

  427 agents  you were tracking 281

WHAT THEY CAN DO

  !   91  no named owner
  !   37  can reach production
  !   46  run somewhere we cannot instrument

WHERE THEY CAME FROM

  enrolment               214
  provider                 94
  pipeline                 71
  vendor                   48
```

Every count links to the record that produced it — a number a security lead cannot drill
into is one they will not repeat to their board. **The gap is the finding**, and it is
theirs rather than ours, which is why the number they had is an input.

The forty-six that cannot be instrumented are named rather than dropped. Governability
is a field, not a filter, or the report quietly covers only the agents that were easy.
A source that could not be read is reported too, so a small count is never mistaken for
a clean one.

## Can this agent hold more authority

```bash
memnox readiness <agentId>
```

```
READINESS  agt_1abb3308

  Ready for level 2 — act reversibly.

Against level 3 — act within bounds

  ✓ owner                 identity store: agent.owner is set
  ✓ audit                 audit log: at least one decision for this agent
  ✗ seam_coverage         seam store: every installed seam is enforcing
                          a seam is installed but not enforcing
                          → memnox harden --apply

A met checklist is evidence for a person, never a grant. Somebody still decides.
```

Every item is a query against something already stored, so the answer cannot be
aspirational and **nobody can tick one**. An item nothing answers yet is `unknown`,
which is not a pass — a readiness checklist over stores that do not exist is a
questionnaire.

Authority is a **named level a person granted**, never a computed score. A scalar that
silently widens or narrows a permission is unauditable and impossible to explain to a
regulator. Down is automatic on an incident; up needs both a met checklist and a
person's name on it.

## What you hand an auditor

```bash
memnox evidence                    # the record for a period
memnox evidence controls --gaps    # what is still missing, per framework
memnox evidence summary
```

The chain travels with it, so it verifies outside this product. Evidence that cannot be
verified without the tool that produced it is a screenshot.

The control mapping prints a disclaimer on every rendering, because the whole risk is
being read as a certificate: it is a self-assessment of implemented controls, not an
audit result.

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
