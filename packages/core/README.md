# @memnox/core

The vocabulary every other package speaks: domain types, the constants that name
their values, and the ports infrastructure implements.

**Zero dependencies.** Not "few" — zero. Everything here is a type, a pure
function, or an interface, so the trust-critical layer carries no supply chain of
its own and can be reasoned about on its own terms.

## What lives here

| Area | Contents |
|---|---|
| Constants | `DECISION_EFFECT`, `RISK_LEVEL`, `AGENT_KIND`, `AGENT_STATUS`, `APPROVAL_STATUS`, `ROLE`, `SOURCE_AUTHORITY`, `TAINT_*` |
| Domain | `ActionRequest`, `ActionEvent`, `Decision`, `AgentIdentity`, `Approval`, `Advisory`, `RiskAssessment`, `ComplianceReport` |
| Pure logic | `evaluateConsent`, `computeTrustScore`, `chainAuditEvent`, `AuditChainVerifier`, `canonicalJson`, `authorityOf`, `roleSatisfies` |
| Ports | `IdentityStore`, `ApprovalStore`, `AuditLog`, `DecisionStore`, `LockService`, `RateLimiter`, `Logger`, `TextCodec` |

## Enum-like constants

There are no TypeScript `enum`s. Values are `as const` objects with a derived
union type, so they survive JSON round-trips and stay comparable across a process
boundary:

```ts
import { DECISION_EFFECT, type DecisionEffect } from '@memnox/core';

DECISION_EFFECT.BLOCK; // 'block'
function handle(effect: DecisionEffect): void {}
```

## Two pieces worth knowing

**`canonicalJson`** — deterministic serialisation with sorted keys. The audit
chain hashes its output, so two runtimes that saw the same event must produce
byte-identical input to the hash. Ordinary `JSON.stringify` does not guarantee
that.

**`evaluateConsent`** — answers *"does this approval authorise this exact
action?"* from the record alone: granted, denied, expired, or not-applicable. It
takes `now` as an argument rather than reading the clock, so replaying an old
decision reproduces the original verdict. Finalising an approval (writing to a
store, appending audit) belongs to `ApprovalService` in `@memnox/runtime` — this
function only judges.

## Adding to core

A type belongs here when more than one package needs it. A function belongs here
when it is pure, deterministic, and has no dependency. Anything that touches a
store, a socket, or the clock belongs in the layer above.
