# Contributing

Memnox decides whether somebody's agent may do something. That is the whole
reason for the rules below: a bug here is not a wrong pixel, it is a gate that
was supposed to be closed.

## Before you open a pull request

- `pnpm test`, `pnpm typecheck`, `pnpm lint` and `pnpm deadcode` all clean.
- Unit tests for new logic; an integration test when a command or endpoint moves.
- `docs/` updated when a user-visible command, flag, file or endpoint changes.
- A new dependency carries a one-line justification in the description.
- Nothing writes outside `~/.memnox/` or `<project>/.memnox/` unless the change
  says so and takes a backup first.

## The three rules review enforces

**1. No `any`.** Use `unknown` and narrow at the boundary. Every method declares
its return type, `async` included. An `as` cast carries a one-line reason. `any`
is how an untrusted MCP payload becomes a trusted object with nobody noticing.

**2. Dependencies point one way** — interface → application → domain — and
infrastructure implements ports the domain defines. Never import another
package's internals, only its `index.ts`. A command holds no logic: when one
grows past shape-checking and rendering, the logic moves to the domain and the
test moves next to it.

**3. Comments are one line and say why.** Never restate the code, never leave a
commented-out block, never open a file with a banner. Anything longer belongs in
`docs/`, where it is read on purpose.

## Two things that are rejected whatever the deadline

**No model on an enforcement path.** Discovery, classification and decisions are
deterministic. A pull request that puts an LLM call between an action and its
verdict is closed, not revised.

**No secret value in output.** Names, counts, structure and fingerprints only.
The failure mode is a screenshot pasted into Slack, and it is unrecoverable.

## Verb tables are code review, not a data drop

`packages/core/src/verbs/` decides what gets asked about. A change that moves
`iam delete-*` from destructive to read is an attack, and "it is only data" is
exactly why it would land. A pull request touching a table names the classes that
moved, in the description.

## Commits

One subject line, no body, no trailers. Keep the prefix the repository already
uses (`feat(cli):`, `fix(policy):`, `docs:`). Say what the commit does.
