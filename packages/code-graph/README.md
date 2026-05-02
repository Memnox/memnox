# @memnox/code-graph

Answers one question, deterministically: **if an agent changes this file, what else does that touch?**

Policies match the path an action names. That is not enough — an agent editing `src/utils/money.ts` is editing payment code if `payment/checkout.ts` imports it. This package builds the import graph that makes that reachability visible, and ships an advisor that escalates on it.

Zero runtime dependencies beyond `@memnox/core` and `@memnox/policy-engine`, no filesystem access, no network, no clock. Same repository in, same graph out.

## Using it

```ts
import { CodeGraph, computeBlastRadius, BlastRadiusAdvisor } from '@memnox/code-graph';

const graph = CodeGraph.build([
  { path: 'src/utils/money.ts', content: 'export const round = …' },
  { path: 'src/payment/checkout.ts', content: "import { round } from '../utils/money';" },
]);

computeBlastRadius(graph, 'src/utils/money.ts');
// { resolvedPath: 'src/utils/money.ts', reached: ['src/payment/checkout.ts'], depth: 1, … }
```

As an advisor on the decision path:

```ts
new BlastRadiusAdvisor(graph, {
  protectedPaths: ['*/payment/*', '*/auth/*'],
  approvers: ['security-team'],
});
```

A `code.modify` on any file that `payment/` transitively imports now needs a human.

## How it is put together

| File | Responsibility |
|---|---|
| `language.ts` | path → language, by extension only |
| `imports.ts` | source text → import specifiers, per language |
| `module-resolver.ts` | specifier → a path in the graph (or null if external) |
| `code-graph.ts` | forward/reverse adjacency, snapshot load/save |
| `blast-radius.ts` | bounded reverse-reachability walk |
| `blast-radius-advisor.ts` | turns a radius into an escalation |

Each stage is a pure function over the stage before it, so a contributor adding a language touches exactly two files: a pattern set in `imports.ts` and, if its module system is unusual, a branch in `module-resolver.ts`.

## Deliberate limits

- **File-level, not symbol-level.** The legacy implementation also derived call edges from regex (`this.dep.method()`). Those edges are too imprecise to escalate a security decision on, so they are not here. Import edges are checkable and explainable; call edges were guesses.
- **Regex parsing, not real parsers.** A parser per language is a dependency tree the trust-critical path cannot carry. The cost is that exotic syntax is missed — which under-reports reach. Since the advisor only ever escalates, a missed edge means a missed escalation, never a wrongful block.
- **Bounded traversal.** `MAX_BLAST_RADIUS_DEPTH` and `MAX_BLAST_RADIUS_NODES` cap the walk; results past a ceiling report `truncated: true` rather than silently shortening.
- **Ambiguity resolves to nothing.** If an action target matches two graph paths by suffix, `resolvePath` returns null and the advisor stays silent. Attributing a blast radius to the wrong file is worse than attributing none.

## Adding a language

1. Map its extensions in `EXTENSION_LANGUAGES` (`code-graph.constants.ts`).
2. Add its import patterns and a `case` in `extractImports` (`imports.ts`).
3. If specifiers are not plain relative paths, add a base-path helper in `module-resolver.ts` (see `pythonBase` / `rustBase`).
4. Add a case to `test/imports.test.ts` and a resolution case to `test/module-resolver.test.ts`.
