# @memnox/risk

Deterministic risk signals that escalate an action without ever allowing one.

Each advisor answers a different question about a request that policy alone
would let through.

## BehaviorAdvisor — is this normal for this agent?

Compares the request against the agent's own audit history: a burst of writes
from an agent that normally reads, a first-ever production touch, a sudden
escalation in verb severity. Deviation from an agent's established baseline
raises an approval, not a block.

```ts
new BehaviorAdvisor(auditLog, ['eng-lead']);
```

The baseline is the audit log, so the signal costs no extra storage and is
replayable.

## VerificationAdvisor — did this agent ever say what happened?

An agent that keeps being allowed to act and never reports an outcome leaves an
unverified trail behind it. Once enough allowed decisions are past the reporting
grace period with no testimony, its next *destructive* action goes to a human
instead of inheriting that trust.

```ts
new VerificationAdvisor(auditLog, ['eng-lead']);
```

Enabled with `serve --verification-guard`. Scoped to destructive verbs on
purpose: silence is a missing record, not evidence of harm, so escalating
ordinary reads because a caller never wired up `runGuarded` would wedge
everyday work.

## The shared contract

Every advisor implements `ActionAdvisor` from `@memnox/core`:

1. May tighten a decision, never loosen it.
2. Deterministic — no clock, no randomness.
3. A thrown error means "no escalation", logged and skipped. Never a crash,
   never a blanket block.

That asymmetry is what makes advisors safe to add: the worst a broken one can do
is fail to catch something.
