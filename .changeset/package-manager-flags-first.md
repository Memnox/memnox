---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

A package install is recognised when flags come before the verb, so `pnpm --filter web add left-pad` is gated as an install rather than read as a command named `web`. The recorded target is now the package rather than a flag such as `-D`, and a bare `yarn` or `pnpm` counts as the install it runs.
