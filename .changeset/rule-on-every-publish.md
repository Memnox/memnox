---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

Publishing is ruled on whichever client ran it. `npm publish` resolved to `npm.publish`, and `pnpm publish`, `yarn npm publish` and `bun publish` were ordinary shell lines, so a rule naming `npm.publish` covered the one spelling most projects do not use. All four now reach the same action, along with `unpublish` and `dist-tag`, and the reason still names the client that ran it. Only the publishing verbs route that way: `pnpm add` is its own install and stays one.

`cargo`, `helm` and `pulumi` have tables of their own. Destructive: `cargo yank`, `helm uninstall`, `helm delete`, `pulumi destroy`. Write: `cargo publish` and `cargo install`, `helm install`, `helm upgrade` and `helm rollback`, `pulumi up` and `pulumi config set`. Read: `cargo search`, `helm list`, `helm status`, `helm get`, `pulumi preview` and `pulumi stack ls`.

`bun`, `uv`, `pipx`, `gem` and `brew` are recognised as installing code that then runs on the machine, which only npm, pnpm, yarn and pip were.
