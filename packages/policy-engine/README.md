# @memnox/policy-engine

The deterministic core of the product: an action request in, a decision out.

**No LLM. No network. No clock. No randomness.** The same request against the
same rule set produces the same decision on every machine, forever. That is what
makes an audit log worth keeping and a replay worth trusting.

## Using it

```ts
import { PolicyEngine } from '@memnox/policy-engine';
import { DECISION_EFFECT } from '@memnox/core';

const engine = new PolicyEngine(policies, { defaultEffect: DECISION_EFFECT.ALLOW });

engine.evaluate({
  action: 'database.delete',
  target: 'users',
  environment: 'production',
});
// { effect: 'block', riskLevel: 'critical', reason: …, matchedPolicies: [...] }
```

## How a decision is reached

1. **Match** — every policy whose `match` block covers the action, target, and
   environment. Patterns are glob-style (`deploy.*`, `payment/*`).
2. **Combine** — the strictest matching effect wins, by `EFFECT_PRECEDENCE`:
   `withhold` > `escalate` > `allow`. Rule order never matters, so two teams
   editing the same file cannot create an ordering bug.
3. **Classify** — `risk-classifier.ts` derives a risk level from the verb and the
   environment, independent of whether a policy matched.
4. **Default** — an action nothing matched gets `defaultEffect`.

## Time windows without breaking determinism

`match.windows` scopes a policy to recurring wall-clock windows — "deploys need
approval outside business hours". The engine never reads the clock: the instant
is passed **into** `evaluate`, and the audit event records it. Replaying the event
feeds back the original instant and reproduces the original decision.

## Versioning and simulation

`versionPolicySet(policies)` content-hashes a rule set. Every audit event carries
that `policyVersion`, so a decision traces back to the exact rules that produced
it.

`comparePolicySets` replays real history through a candidate rule set and reports
what would change — flagging anything that becomes **more permissive**. The CLI
exposes it as `memnox policy simulate <file>`.

## Layout

| File | Responsibility |
|---|---|
| `policy.ts` | the `Policy` shape and its effect/decision types |
| `pattern-matcher.ts` | glob matching for actions, targets, environments |
| `time-window.ts` | recurring wall-clock window matching |
| `risk-classifier.ts` | verb + environment → `RiskLevel` |
| `policy-validator.ts` | structural validation with actionable messages |
| `policy-engine.ts` | match → combine → classify |
| `policy-version.ts` | content hash of a rule set |
| `policy-simulator.ts` | replay history against a candidate set |
| `policy-packs.ts` | five starter packs, name-collision safe |

## The rule for contributors

Any change that makes evaluation depend on something outside its arguments —
ambient time, a file read, an environment variable, a random value — breaks
replay and will be rejected. If evaluation needs a fact about the world, the
caller passes it in.
