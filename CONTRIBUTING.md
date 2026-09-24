# Contributing

Memnox decides whether somebody's agent may do something. That is the reason for
every rule below: a bug here is not a wrong pixel, it is a gate that was supposed
to be closed.

New here? Read [`ARCHITECTURE.md`](ARCHITECTURE.md) first: four packages, one
direction of dependency, and one path every decision travels down. It ends with a
table of where to make each kind of change.

## Getting set up

```sh
git clone https://github.com/Memnox/memnox.git
cd memnox
pnpm install          # pnpm 11, Node 22 or 24
pnpm build            # every package, in dependency order
pnpm test             # ~2100 tests, a few seconds
pnpm bench            # the wall-clock ones, run on purpose
```

Run your working copy against your own machine:

```sh
node packages/cli/dist/index.js scan
node packages/cli/dist/index.js doctor --wiring
```

`pnpm build` first, because the `dist/` you just ran is whatever was last built, and a
change you did not build is a change you did not test.

Nothing in the suite reads your home directory, spawns an agent, or watches a real
directory. If a test you write needs one of those, inject it instead; see **Seams**
in `ARCHITECTURE.md`.

## Before you open a pull request

```sh
pnpm format && pnpm typecheck && pnpm test && pnpm deadcode
```

All four, clean. CI runs them on Ubuntu and macOS against Node 22 and 24, plus a
publish dry run, because a shim that works on one platform and not the other is the bug
that matrix exists to catch.

- Unit tests for new logic; an integration test when a command or a flag moves.
- `docs/` updated when a user-visible command, flag, file or path changes.
- A new dependency carries a one-line justification in the description. `core` has
  three and none of them reaches a network; adding a fourth is a conversation.
- Nothing writes outside `~/.memnox/` or `<project>/.memnox/` unless the change
  says so and takes a backup first.

## Clean code, and where each principle is held

Five principles, each mapped to the rule below that holds it, so a review can point at
one line rather than argue taste.

| Principle | What it means here | Held by |
|---|---|---|
| DRY | One owner per helper, constant and list. Search before you write one. | 3, 4b |
| KISS | The plainest code that works: no nested ternaries, no clever one-liners. | 4b |
| Single responsibility | A function does one job; a module holds one kind of thing. | 2, 3a, 4b |
| Meaningful names | A name says what the thing does, in the shared vocabulary. | 3b, 4a |
| Small functions | At most forty lines and four parameters, one level of abstraction. | 4b |

## The rules review enforces

**1. No `any`.** Use `unknown` and narrow at the boundary. Every function declares
its return type, `async` included. An `as` cast carries a one-line reason. `any` is
how an untrusted MCP payload becomes a trusted object with nobody noticing.

**2. Dependencies point one way**, interface to application to domain, and
infrastructure implements ports the domain defines. Never import another package's
internals, only its `index.ts`. A command holds no logic: when one grows past
shape-checking and dispatch, the logic moves out and the test moves with it.

**3. No magic values.** A number or a string that means something gets a named
constant, in the one place that owns it. A path built in two files is one rename from
being written by one command and looked for by another, and an action name spelled in
two files is a rule that silently stops firing. Before you declare one, check the table
in `ARCHITECTURE.md` under **Where a shared constant lives**: durations, exit codes,
HTTP statuses, action names, ledger limits and the Memnox home all already have an
owner, and a second copy is the bug.

**3a. A command with several subcommands registers them and nothing else.** `agents`
and `setup` keep their wiring in `<name>.command.ts` and one `run*` function per
subcommand in `commands/<name>/`, so the registration file reads as a list of what the
command offers. `test/one-rail.test.ts` reads that folder together with the command
file, so moving a handler out never moves it out of a check.

**3b. One shape per job, and a test holds you to it.** `packages/cli/test/house-style.test.ts`
asserts the three that were actually diverging, across all four packages:

- A command **registers and delegates**. `register<X>Command` declares its flags and each
  `.action()` is one call to a `run<Something>` function. That is what makes a command
  testable without commander, and what makes thirty-one files read as one product.
- Every non-trivial module **opens with a doc comment** saying what it is. A newcomer
  opening `policy-engine.ts` should not have to read the imports to find out.
- `render*` **writes to the rail** and `describe*` **returns a string**. In `core`, which
  has no rail, `render*` produces the text instead. There is no `say*`.

The verb vocabulary the rest of the codebase already uses, so reach for these before
inventing one: `run` (do the thing), `render`/`describe` (present it), `read`/`write`
(persist it), `is`/`has`/`matches` (ask about it), `parse`/`classify`/`resolve` (turn one
shape into another), `build` (assemble a collaborator).

The same goes for shapes. A command's injected collaborators are `<Name>Deps` and its
flags are `<Name>Options`; a function is a `function` declaration rather than an arrow
assigned to a const; an array parameter is `readonly` unless the function mutates it;
and a failure throws in `packages/cli` and returns `null` or an outcome everywhere else.
None of that was decided in a style meeting, it is what the code already does, and
`house-style.test.ts` holds the parts of it a test can check.

**4. Comments are short and say why.** Never restate the code, never leave a
commented-out block, never tell the story of how the code got here: that is what git
history is for. The limits are checked by `house-style.test.ts`:

- A module opens with a `/** */` comment saying what it is, in at most three lines.
- A symbol gets at most one `/** */` comment, of at most three lines.
- Inside a function, a comment is `//` and at most two lines. There is no `/* */`.

Anything longer belongs in `docs/`, where it is read on purpose.

```ts
// WRONG: a banner, and it restates the function below
/* =====================================================
 *  Tool classifier, mapping tool names to read / write /
 *  destructive using the verb table.
 * ===================================================== */

// WRONG: history. Nobody reading this needs to know what it used to do.
// This used to read only mcpServers, which missed VS Code for a release.

// RIGHT
// Annotations win over the verb table: the server author knows the tool better than we do.
```

**4a. Names say what the thing is, in the words the rest of the code uses.**

| Kind | Shape | Example |
|---|---|---|
| Function | verb first, from the vocabulary in 3b | `readRecord`, `isWriteCapable`, `renderAgent` |
| Predicate | `is`, `has`, `matches`, `can` | `isCredentialExposure`, `hasLease` |
| Conversion | `xToY`, or `yOf(x)` for a lookup | `minutesToMs`, `hostnameOf` |
| Constant set | `UPPER_SNAKE` object `as const`, and a type derived from it | `EXIT`, `SENSITIVITY` |
| Collaborators | `<Name>Deps`; flags `<Name>Options`; a long argument list `<Name>Input` | `SetupDeps`, `OfferInput` |
| Local | camelCase, a whole word, never one letter outside a tiny callback | `servers`, not `s` |

A name that says one thing and does another is a bug, even when the tests pass: `ask()`
that raises a risk level, or `toCents()` that returns dollars, will be misused by the
next person who trusts it. Two exported functions with the same name in two modules is
the same bug.

**4b. Small enough to hold in your head.** Also checked by `house-style.test.ts`:

- A function does one job at one level of abstraction, in at most forty lines. Past
  that, name the steps and call them.
- A function takes at most four parameters. Past that, it takes one object, named
  `<Name>Input`, so every call site says which value is which.
- A module stays under five hundred lines. Past that it is doing more than one job.
- A value the function could be handed (`process.cwd()`, `process.env`, `homedir()`,
  `new Date()`) is handed to it, the same way `home` and `now` already are.
- Before writing a helper, search for it. A second copy of a helper is a second place
  for the same bug, and the copies drift apart.

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
- **A command gets its program built with fakes**, which `test/cli-harness.ts` does
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

Changesets open a version PR; the release is cut by merging it, never by a push to
`main` on its own. `pnpm version` bumps the manifests and syncs `CLI_VERSION` with
them, so never edit that constant by hand, because `memnox --version` reading a number the
package was not published under is a bug this project has already shipped once.

## Reporting something that should not be public

A policy bypass or an audit-tampering finding goes through GitHub's private
vulnerability reporting, not an issue. [`SECURITY.md`](SECURITY.md) has the detail.
