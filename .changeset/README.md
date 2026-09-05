# Changesets

Every user-visible change ships with one. `pnpm changeset` writes a file here saying
what changed and how the version should move; `pnpm changeset version` applies them.

The four packages are **fixed**: they release together on one version, because a CLI
built against a different `@memnox/core` than it ships with is the bug this prevents.
