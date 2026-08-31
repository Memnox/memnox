# @memnox/workflow

Work that keeps moving, with a gate on every route that hands something out.

## The invariant, mechanically

**Every route to a delegation passes a decision or an approval.** `validateWorkflow`
walks backward from every delegate node to the trigger; if any path reaches the trigger
without crossing a gate, the save is refused. A gated happy path proves nothing about
the branch somebody added underneath it later, so every path is walked.

```ts
import { validateWorkflow, isValid } from '@memnox/workflow';

if (!isValid(draft)) throw new Error('a delegation with no gate on some path');
```

The console mirrors this while somebody is still drawing; the server enforces it
regardless. A workflow that could hand out work before a human can be asked is an
automation tool wearing a governance page.

## The briefing

A dispatch carries four things: the objective, the context **with its trust levels**,
the constraints, and a capability rather than a key. Trust survives the handoff — losing
it at the boundary reopens the injection path the decision object closed. So does the
correlation id, so a delegated run shows up as a lineage hop rather than a new actor.

## What it never does

Memnox never does the work. No step writes the code or issues the refund. A connector
is what a trigger listens to and what a context step reads, never a hand that acts.
