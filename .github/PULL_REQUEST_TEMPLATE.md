## What this changes

<!-- The failure mode this prevents, or the capability it adds. Two or three sentences. -->

## How it was verified

<!-- Which tests cover it. If it changes a decision path, name the audit event it appends. -->

## Checklist

- [ ] `npm run format && npm run typecheck && npm test && npm run deadcode` all pass
- [ ] Behavior change ships with a test
- [ ] No `any`, no magic values, no `console.*` outside a composition root
- [ ] If this touches the decision path: still deterministic — no LLM, network, clock, or randomness
- [ ] If this adds escalation logic: it is an `ActionAdvisor` that only tightens, and its failure means "no escalation"
