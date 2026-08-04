# @memnox/organization

Ask your organization before your agent acts.

Your agent already knows how to reach its tools. This answers the question it
cannot answer on its own: given this company, should you be doing this, who
should be involved, and what are you allowed to know while you do it.

Apache-2.0. The protocol is open; the organization it talks to is a service.

```bash
npm install @memnox/organization
```

## One call

```ts
import { MemnoxOrganization, mayProceed } from '@memnox/organization';

const memnox = new MemnoxOrganization({
  token: process.env.MEMNOX_GRANT!,
  workspace: 'acme',
});

const answer = await memnox.evaluate({
  action: 'payment.refund',
  resource: { type: 'customer', id: 'c_481' },
  principal: 'sarah@acme.test',
  amount: 4500,
  reason: 'duplicate charge reported in ticket 8812',
  reads: factIds,
});

if (mayProceed(answer)) {
  await stripe.refunds.create({ /* ... */ });
} else {
  // answer.decision is one of deny, ask, escalate, delegate, clarify.
  // answer.approvers names who can authorize it, and why they can.
}
```

## The six answers

| Decision | What it means |
|---|---|
| `allow` | Proceed |
| `deny` | A rule forbids it. Final |
| `ask` | Approval is required and nobody is named |
| `escalate` | Approval is required and the organization names who gives it |
| `delegate` | You may act but may not know. Somebody who can, owns it |
| `clarify` | Context is missing and nobody available can supply it |

## Everything it can ask

| Call | Question |
|---|---|
| `evaluate` | Should this happen, and what may I know while doing it |
| `context` | What does the company know that bears on this |
| `owner` | Who owns this, and through which decision |
| `decisions` | What has already been decided about this topic |
| `policy` | Which verified rules apply here |
| `person` | What may this person authorize, and up to what |
| `agentsFor` | Which agents this company runs for an action |
| `precedent` | What happened the last times this action was asked about |
| `canShare` | May I repeat this to them |
| `require` | Evaluate, and throw unless it is a plain allow |

Nothing here writes. Execution stays yours.

## Three things worth doing

**Send `reads`.** The fact ids your action relies on are what let the answer
tell "you may not do this" apart from "you should not be the one who knows
this". Without them you will never see a delegation.

**Read `withheld`.** A non-zero count means your answer is partial and you do
not know how. That is a reason to involve a person, not a reason to proceed
confidently.

**Carry `constraints` into your prompt.** They are the limits stated in words,
and a model that was never told them cannot respect them.

## What this package does not do

It does not execute anything, does not touch your tools, and does not need your
connectors. It never fails open: a call that cannot reach the organization
throws rather than returning a permissive default.

Full documentation: <https://docs.memnox.com/govern/evaluate>
