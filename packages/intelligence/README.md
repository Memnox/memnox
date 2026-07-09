# @memnox/intelligence

The optional LLM layer. It drafts, explains, and classifies — it **never
decides**.

Everything here sits beside the decision path, never on it. Remove this package
entirely and every decision the runtime makes is unchanged.

## Why it is separate

A security decision needs a guarantee, not a probability. The moment a model
influences a verdict, the audit log stops being reproducible and "same input,
same decision" stops being true. So the boundary is structural, not a convention:
nothing in `@memnox/policy-engine` or the gateway's decision path imports this
package.

## What it does

**Draft a policy from a sentence.** The output is parsed and validated against
the real policy schema, then printed for you to review and commit — it is never
loaded live.

```ts
const draft = await new PolicyDrafter(provider).draft(
  'nobody should be able to delete production data',
);
```

```bash
memnox draft "nobody should delete production data" > candidate.yaml
memnox validate candidate.yaml
```

**Explain a decision.** Turns a decision plus its matched policies into plain
language for a Slack message or a PR comment. The decision already happened; this
only narrates it.

**Classify intent.** `IntentClassifier` expands a stated goal into the candidate
actions it would involve, each rated by the **deterministic** risk classifier
rather than by the model. The model proposes the action list; the engine rates it.

```bash
memnox intent "clean up the staging database"
```

Advisory only — the gate still decides on each action when it is actually
attempted.

## Providers

BYOK. `AnthropicProvider` and `OpenAiProvider` implement `LlmProvider`; supply
your own to use anything else.

```ts
new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY });
```

Keys are read from the environment and never persisted. `EmbeddingProvider` is
the same arrangement for `@memnox/memory`'s optional semantic search.

## Every call has a fallback

An LLM call that fails must never take down the caller. Parse output inside
try/catch, validate field types explicitly, and return a rules-based fallback —
never trust raw model output, and never let a provider outage become an outage
here.
