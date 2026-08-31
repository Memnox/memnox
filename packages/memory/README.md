# @memnox/memory

Team decisions, recorded once, enforced automatically.

A decision like *"migrations run through the release pipeline, never by hand"*
normally lives in a Slack thread nobody reads and an onboarding doc nobody
updates. Here it becomes a constraint the gateway checks on every matching
action.

## Recording one

```ts
import { DecisionRegistry } from '@memnox/memory';

await registry.register({
  title: 'No direct production migrations',
  statement: 'Migrations run through the release pipeline.',
  owner: 'platform-team',
  actions: ['database.migrate'],
  environments: ['production'],
  enforcement: 'escalate',
  sourceRef: 'https://slack.com/archives/...',
});
```

From the CLI: `memnox memory add --title … --actions database.migrate`.

## Enforcement

`DecisionMemoryAdvisor` sits on the decision path. A matching decision escalates
the action to its `enforcement` level and names itself in the reason, so an agent
is told *which* team decision stopped it and who owns it — not just "denied".

Like every advisor it only tightens. A recorded decision cannot allow something
policy blocks.

## Search

`DecisionSearch` is deterministic keyword matching. `DecisionSemanticSearch`
layers embedding retrieval on top behind the same signature, fusing both result
sets with reciprocal rank fusion.

Embeddings are BYOK and optional: without a key, semantic search degrades to
keyword search rather than failing. Retrieval quality is not on the decision
path, so a degraded index never changes a verdict.

## Corpus health

A decision corpus rots. `decision-health.ts` scores it and names the specific
failures:

| Signal | Meaning |
|---|---|
| stale | not referenced in a long time |
| frequently violated | agents keep hitting it — the rule or the workflow is wrong |
| never referenced | it has never matched anything; possibly mis-scoped |
| due for review | past its `reviewAfter` date |

`memnox memory health` prints it. A rule that has fired zero times in six months
is usually written against an action name that does not exist.

## Digest

`decision-digest.ts` renders the active constraints as text you can paste into an
agent's system prompt — the agent knows the rules *before* it tries something,
instead of learning them from a denial.

## Layout

| File | Responsibility |
|---|---|
| `decision-record.ts` | the record shape and its status transitions |
| `decision-fingerprint.ts` | stable identity for matching and dedup |
| `decision-registry.ts` | register, retire, supersede |
| `decision-search.ts` | deterministic keyword search |
| `vector-index.ts` / `semantic-search.ts` | optional embedding retrieval |
| `decision-health.ts` | corpus scoring |
| `decision-digest.ts` | prompt-injectable summary |
| `decision-memory-advisor.ts` | the escalation hook |
| `json-file-decision-store.ts` | zero-infrastructure store |
