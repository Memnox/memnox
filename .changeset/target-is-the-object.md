---
'@memnox/interceptors': patch
'@memnox/core': patch
'@memnox/proxy': patch
'memnox': patch
---

Fix the target a command resolves to, so `targets`-scoped rules match anything at all.
`resolveAction` took the first non-flag argument, which is the subcommand — every
`git push` resolved to `target: "push"`, so the rule in the README could not fire on
the command it exists to stop, and neither could any other rule written with
`targets`. It is now the last positional argument the verb did not consume, which is
where CLI grammar puts the object.

The gate, the matcher and the layering were always right; the request handed to them
was wrong. This affects every seam, since they all resolve through the same function.

`packages/core/test/command-to-verdict.test.ts` covers the seam that let this through:
a command line a person would type, through resolution, to a verdict. Nothing tested
that path before, which is why 1044 tests passed while the documented rule did nothing.
