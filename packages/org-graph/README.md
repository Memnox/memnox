# @memnox/org-graph

What an organization has said about itself, as a domain rather than a document:
verified statements, delegated authority, ownership, and the verdict those imply
for one action.

**No LLM. No network. No clock. No randomness.** Like `@memnox/policy-engine`,
the same question against the same graph gives the same answer on every machine.
A statement may be *drafted* by a model — see `@memnox/intelligence` — but a
drafted statement is a proposal a human confirms, and nothing a model produced
reaches a verdict here.

## Why it is its own package

The runtime serves the organization protocol, the authority advisor escalates on
it, and the extractor drafts into it. All three need the same vocabulary for
"who said this, on whose authority, and may this caller know it". Three
near-copies of that vocabulary would drift, and the first thing to drift would be
who is allowed to read what.

## The pieces

| Concern | What it answers |
|---|---|
| `stated` | What was said, by whom, how it was established, and whether it still stands |
| `authority` | What a principal may authorise, and what exceeds it |
| `ownership` | Who a thing belongs to |
| `fact` | What a caller may be told, given clearance |
| `verdict` | Which of the organization's answers this action gets |

## Using it

```ts
import { evaluateAuthority, decideFrom, readableFacts } from '@memnox/org-graph';

// What may this principal authorise?
const verdict = evaluateAuthority(question, grants);

// Which answer does the organization give?
const decision = decideFrom(facts);
```

## Authority is not identity

A credential settles *who the agent is*, and that happens before policy runs.
Authority is whose power the agent is drawing on, and the two carry different
numbers: a person may approve fifty thousand and an agent acting for them five.
Collapsing them means an agent inherits everything its principal can do, which
is the one thing delegation exists to prevent.

## Being told is not being allowed

A verdict distinguishes "you may not do this" from "you may, but you should not
be the one who knows it". `readableFacts` filters by clearance, so an answer can
be withheld without the question itself leaking what it was about.

## Licence

Apache-2.0.
