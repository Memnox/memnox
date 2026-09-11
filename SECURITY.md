# Security Policy

Memnox is a security control. A flaw here can let an AI agent take an action a
policy was written to stop, so we treat vulnerability reports as the highest
priority work in the project.

## Reporting a vulnerability

**Do not open a public issue.**

Use GitHub's private vulnerability reporting on this repository
(**Security → Report a vulnerability**). It is the fastest path and keeps the
report private until a fix ships. If that is unavailable to you, email
`support@memnox.com`.

Please include:

- the version or commit you tested,
- a policy file and action request that reproduce the behaviour,
- what you expected the decision to be, and what it actually was.

You will get an acknowledgement within 3 working days and a fix or a mitigation
plan within 14 days for anything that lets an action bypass a policy.

## What counts as a vulnerability

Anything that breaks one of the runtime's guarantees:

| Guarantee | A report is in scope if it shows |
|---|---|
| Policy is authoritative | an action runs that a matching rule denies |
| Decisions are deterministic | identical input produces different verdicts |
| A held call stays held | an `ask` proceeds without somebody answering it |
| A secret value never leaves the process that read it | a credential value reaching a report, a snapshot, a ledger row, or any output |
| The ledger is append-only | a recorded event altered or removed without the database refusing it |
| Removal is complete | something Memnox installed surviving `memnox uninstall` |
| Every governed action is recorded | an action that was ruled on leaving no row behind |

A `tools/call` reaching the wrapped server after the MCP proxy denied it is in
scope, as is a shell line that reaches a binary after the seam denied it.

## What does not count

- **A permissive policy file.** Memnox enforces the rules it is given. A rule set
  that allows something dangerous is a configuration issue.
- **An action no rule matches.** Unmatched actions are **allowed**, and this is the
  default rather than something switched on: `PolicyEngine` and `LocalGate` both fall
  back to allow, and there is no flag to change it. A runtime that denied everything
  it had no rule for would deny the first command on the first machine, which is why
  a new machine also starts in `observe`. Rule sets are therefore deny lists over a
  permissive floor, and a report that an unruled action ran is that floor working as
  designed. An action a matching rule *denies* is the one that is in scope, above.
- **Anything that needs write access to the rules or to `~/.memnox`.** Whoever can
  edit your rule file can edit your shell profile. `docs/threat-model.md` states
  that boundary rather than leaving it to be found.
- **`PATH` being advisory.** An agent calling `/usr/bin/git` by absolute path never
  meets an interceptor. That is a stated limit, and the OS guard, the git hooks and
  the MCP proxy each close part of it. A report showing one of *those* bypassed is
  in scope.

## Supported versions

Pre-1.0, only the latest minor version receives security fixes.

## Disclosure

We aim to publish an advisory once a fix is released, crediting the reporter
unless anonymity is requested. Please give us the 14 days before disclosing
publicly.
