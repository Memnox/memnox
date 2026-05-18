# @memnox/risk

Deterministic risk signals that escalate an action without ever allowing one.

Three advisors, each answering a different question about a request that policy
alone would let through.

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

## TrustAdvisor — has this agent earned this?

`computeTrustScore` turns an agent's allowed/blocked/approval-requested counts
into a 0–100 score. A low-trust agent attempting a risky action needs a human,
even where a high-trust agent would not.

```ts
new TrustAdvisor(['eng-lead']);
```

Trust is earned by a clean history and lost by blocks. It never grants
permission — it only withholds the benefit of the doubt.

## DependencyAdvisor — is this package safe to add?

Governs `dependency.add` against two things: the curated vulnerability table in
`@memnox/content-shield`, and the package's license.

```ts
new DependencyAdvisor(new StaticLicenseResolver(), ['security-team']);
```

Licenses resolve through a `LicenseResolver` port. The default
`StaticLicenseResolver` is offline. `NpmRegistryLicenseResolver` is opt-in behind
`--dependency-license-lookup`, because the decision path does not make network
calls unless you ask it to.

**An unknown license raises nothing.** Neither does an unreachable registry. The
advisor escalates on what it knows is a problem, never on absence of information —
otherwise a registry outage would block every install.

## The shared contract

All three implement `ActionAdvisor` from `@memnox/core`:

1. May tighten a decision, never loosen it.
2. Deterministic — no clock, no randomness.
3. A thrown error means "no escalation", logged and skipped. Never a crash,
   never a blanket block.

That asymmetry is what makes advisors safe to add: the worst a broken one can do
is fail to catch something.
