# Security Policy

Memnox is a security control. A flaw here can let an AI agent take an action a
policy was written to stop, so we treat vulnerability reports as the highest
priority work in the project.

## Reporting a vulnerability

**Do not open a public issue.**

Use GitHub's private vulnerability reporting on this repository
(**Security → Report a vulnerability**). It is the fastest path and keeps the
report private until a fix ships. If that is unavailable to you, email
`security@memnox.dev`.

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
| Policy is authoritative | an action executes that a matching policy blocks |
| Decisions are deterministic | identical input produces different decisions |
| Escalation is one-way | an advisor loosens a decision instead of tightening it |
| Identity is fail-closed | an unknown, revoked, or suspended token is honoured |
| Consent is bound | an approval is reused for a different action than it was granted for |
| Audit is tamper-evident | the chain verifies after a record is altered or removed |

Bypasses of the MCP firewall (a `tools/call` reaching the wrapped server after a
deny) are in scope.

## What does not count

- **A permissive policy file.** Memnox enforces the rules it is given. A rule set
  that allows something dangerous is a configuration issue.
- **`--default-effect allow`.** Allowing unmatched actions is opt-in behaviour and
  documented as such.
- **Break-glass overrides.** `approvals override` is an intentional admin escape
  hatch. It requires the admin token and a reason, and is audited as critical.
- Findings that require an attacker who already holds the admin token or write
  access to the policy file.

## Supported versions

Pre-1.0, only the latest minor version receives security fixes.

## Disclosure

We aim to publish an advisory once a fix is released, crediting the reporter
unless anonymity is requested. Please give us the 14 days before disclosing
publicly.
