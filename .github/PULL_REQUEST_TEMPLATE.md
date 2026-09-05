## What this changes

<!-- The failure mode this prevents, or the capability it adds. Two or three sentences. -->

## How it was verified

<!-- Which tests cover it. If it changes what a verdict can be, name the test that pins it. -->

## Checklist

- [ ] `pnpm format && pnpm typecheck && pnpm test && pnpm deadcode` all pass
- [ ] Behaviour change ships with a test
- [ ] No `any`, no magic values, no `console.*` outside `cli-output.ts`
- [ ] If this touches the decision path: still deterministic — no LLM, network, or randomness
- [ ] If this changes a verb table: the classes that moved are named above
- [ ] If this changes a command, flag or file it writes: `docs/` says so
