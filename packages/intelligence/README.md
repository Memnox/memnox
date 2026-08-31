# @memnox/intelligence

The optional LLM layer. It **drafts**, and that is all it does.

It never decides, never explains a decision, and never infers what somebody
meant. Two things that used to live here are gone on purpose: a decision is
explained by `buildExplanation`, built from the same match the verdict came from,
and intent arrives as a declared `Task` from the client that already knows it.

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

**Extract structure from a source.** `OrganizationExtractor` proposes candidate
statements out of a connected system, each carrying the excerpt it came from.
Deterministic rules run first; the model reaches only what rules cannot.

## What it will not grow back

**Explaining a decision.** An explanation produced after the fact by a model is a
plausible story about a decision, which is worse than none. `buildExplanation` in
`@memnox/core` reads the decision, the request and the scope comparison, and
every line it emits cites the rule version or the context block behind it.

**Inferring intent.** Asking whether an action fits the task is the strongest
check in the category and the easiest to build badly. The version that infers it
puts a model on the hot path. A client declares a `Task` with its scope,
`compareDeclaredScope` compares deterministically, and the ambiguous middle
escalates to a person rather than to a classifier.

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
