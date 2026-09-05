# Contributing

Memnox decides whether somebody's agent may do something. That is the reason for
every rule below: a bug here is not a wrong pixel, it is a gate that was supposed
to be closed.

New here? Read [`ARCHITECTURE.md`](ARCHITECTURE.md) first — four packages, one
direction of dependency, and one path every decision travels down. It ends with a
table of where to make each kind of change.

## Getting set up

```sh
git clone https://github.com/Memnox/memnox.git
cd memnox
pnpm install          # pnpm 11, Node 20 or 22
pnpm build            # every package, in dependency order
pnpm test             # ~1000 tests, about three seconds
```

Run your working copy against your own machine:

```sh
node packages/cli/dist/index.js scan
node packages/cli/dist/index.js doctor --wiring
```

`pnpm build` first — the `dist/` you just ran is whatever was last built, and a
change you did not build is a change you did not test.

Nothing in the suite reads your home directory, spawns an agent, or watches a real
directory. If a test you write needs one of those, inject it instead — see **Seams**
in `ARCHITECTURE.md`.

## Before you open a pull request

```sh
pnpm format && pnpm typecheck && pnpm test && pnpm deadcode
```

All four, clean. CI runs them on Ubuntu and macOS against Node 20 and 22, plus a
publish dry run — a shim that works on one platform and not the other is the bug
that matrix exists to catch.

- Unit tests for new logic; an integration test when a command or a flag moves.
- `docs/` updated when a user-visible command, flag, file or path changes.
- A new dependency carries a one-line justification in the description. `core` has
  three and none of them reaches a network; adding a fourth is a conversation.
- Nothing writes outside `~/.memnox/` or `<project>/.memnox/` unless the change
  says so and takes a backup first.

## The rules review enforces

**1. No `any`.** Use `unknown` and narrow at the boundary. Every function declares
its return type, `async` included. An `as` cast carries a one-line reason. `any` is
how an untrusted MCP payload becomes a trusted object with nobody noticing.

**2. Dependencies point one way** — interface → application → domain — and
infrastructure implements ports the domain defines. Never import another package's
internals, only its `index.ts`. A command holds no logic: when one grows past
shape-checking and dispatch, the logic moves out and the test moves with it.

**3. No magic values.** A number or a string that means something gets a named
constant, in the one place that owns it. A path built in two files is one rename
from being written by one command and looked for by another.

**4. Comments are one line and say why.** Never restate the code, never leave a
commented-out block, never open a file with a banner. Anything longer belongs in
`docs/`, where it is read on purpose.

```ts
// WRONG — a banner, and it restates the function below
/* =====================================================
 *  Tool classifier — maps tool names to read / write /
 *  destructive using the verb table.
 * ===================================================== */

// RIGHT
// Annotations win over the verb table: the server author knows the tool better than we do.
```

**5. An empty function body is a lie about what the code does.** If a seam is not
wired, say so where it would have been wired and in the docs. The MCP proxy went a
release recording nothing behind a comment that said every call reached the ledger,
and every test passed the whole time.

## Two things that are rejected whatever the deadline

**No model on an enforcement path.** Discovery, classification and decisions are
deterministic. A pull request that puts an LLM call between an action and its
verdict is closed, not revised.

**No secret value in output.** Names, counts, structure and fingerprints only. The
failure mode is a screenshot pasted into Slack, and it is unrecoverable.

## Verb tables are code review, not a data drop

`packages/core/src/verbs/` decides what gets asked about. A change that moves
`iam delete-*` from destructive to read is an attack, and "it is only data" is
exactly why it would land. A pull request touching a table names the classes that
moved, in the description.

## Tests

Vitest, no framework beyond it. A test file sits next to the package it covers, in
`packages/*/test/`, named for the thing rather than the file.

- **Pure logic gets a unit test** with no filesystem at all.
- **A command gets its program built with fakes** — `test/cli-harness.ts` does this
  for a command whose collaborator would otherwise spawn something.
- **Never assert against a real watched directory or a real clock.** Both have cost
  a green suite before: an fs watcher that had not armed yet failed one run in ten,
  and a suite that fails at random is a suite everybody re-runs instead of reading.

## Commits

One subject line, no body, no trailers. Keep the prefix the repository already uses
(`feat(cli):`, `fix(policy):`, `docs:`, `refactor(core):`). Say what the commit
does, in under 80 characters.

A user-visible change also needs a changeset:

```sh
pnpm changeset
```

Releases are cut by merging the version PR that opens, never by a push to `main`.

## Reporting something that should not be public

A policy bypass or an audit-tampering finding goes through GitHub's private
vulnerability reporting, not an issue. [`SECURITY.md`](SECURITY.md) has the detail.
