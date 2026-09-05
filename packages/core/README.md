# @memnox/core

Everything the other three packages reason with: the domain types, the rule
engine, the ledger, and the adapters that read a real machine. Nothing here
knows about a terminal, a process tree, or an MCP session.

Published because the CLI depends on it. Its API is not stable before 1.0.

## What lives here

| Folder | Holds |
|---|---|
| `constants/` | the value sets everything else names — `DECISION_EFFECT`, `ENFORCEMENT_MODE`, `RISK_LEVEL`, `ACTION_CLASS` |
| `domain/` | pure types and pure logic: an action, a decision, an explanation, shell normalization, canonical JSON, digests |
| `policy/` | the rule file, the matcher, the engine, layering, overlays, validation |
| `discovery/` | what is on a machine and what it reaches: agents, MCP servers, credentials, browsers, the doctor, the gap |
| `gate/` | the local gate an interceptor asks — evaluate, hold, prompt, resolve |
| `event/` | the frozen v1 event and the append-only SQLite ledger behind it |
| `ledger/` | what a ledger of events adds up to: usage, unused grants, collisions |
| `verbs/` | the per-CLI verb tables that decide what `git push` or `aws s3 rm` counts as |
| `recovery/` | milestones and the pre-flight check `memnox check` runs |
| `intercept/` | how a command line is resolved and classified before it runs |
| `config/`, `daemon/`, `render/` | the config file, the daemon's wire protocol, and pure string builders |

## Two rules this package keeps

**Deterministic, all of it.** No model is consulted anywhere in here — not in
discovery, not in classification, not in a verdict. A rule table and a matcher
produce every answer, so the same input always produces the same output and a
prompt cannot talk one around.

**A secret value never becomes a field.** Discovery reports a path, a kind and a
count; the ledger stores a digest of arguments and never the arguments. The event
schema refuses a digest field long enough to be a payload.

## Layering

`domain/` and `constants/` import nothing but each other. `policy/`, `gate/` and
`discovery/` build on them and define the ports they need. The `Node*` classes
(`NodeMachineReader`, `NodeSnapshotStore`, `NodeMcpLister`, `SqliteEventStore`)
are the adapters that touch a real disk, and they are the only things in here
that do.

## Dependencies

`better-sqlite3` for the ledger, `yaml` and `smol-toml` for reading rule files.
Nothing else, and nothing that reaches a network.

Apache-2.0.
