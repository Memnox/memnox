# @memnox/ledger

The local record. Not only what the agents did, but **what they never needed**.

A day of ordinary work becomes a policy file the developer reads, edits, applies and
commits, and their agents keep working.

```ts
import { rollUpUsage, findUnusedGrants, proposeLeastPrivilege, renderProposal } from '@memnox/ledger';

const usage = rollUpUsage(observations);
const unused = findUnusedGrants(granted, usage, 4);
console.log(renderProposal(proposeLeastPrivilege({ agentId, usage, unused, windowDays: 4, sessions: 11, coverage: 0.62 })));
```

## What it stores

Arguments hashed, results summarised. A ledger that stores what an agent read becomes
the thing worth stealing — on a laptop, unencrypted — and the product would be the
vulnerability. Frames carry a `payloadDigest`, never a payload.

Full fidelity on anything withheld or escalated, sampled on the allowed majority, where
the bytes are. Sampling is deterministic off the decision id, so a replay of the same
day keeps the same frames.

## Sample size is part of the answer

A proposal from four days of one developer's work is not a policy for a team.
`derivedFrom` carries the window, the sessions and the coverage, and `renderProposal`
puts them in the file itself, where they cannot be dropped in the retelling.

## Lineage honesty

Cross-system causation cannot be propagated everywhere. A correlation id in a commit
trailer works; a pipeline claim works; the rest is inference. Every hop records its
`method` and its confidence, and `lineageConfidence` reports the chain at its weakest
hop. An inferred hop that pretended to be a propagated one would be worse than a gap.
