# Event schema v1

One row per thing an agent tried to do. **Frozen**: the cloud ingests against this, so
a change here is a new version and never an edit. Additive optional fields are the only
safe change within v1.

Published as JSON Schema at `https://memnox.dev/schema/event-v1.json`, and exported as
`EVENT_SCHEMA` from `@memnox/core`.

## Required

| Field | Type | Notes |
|---|---|---|
| `id` | string | stable across a resend, so the cloud dedupes on it |
| `schemaVersion` | 1 | refused if it is anything else |
| `at` | ISO 8601 | supplied by the caller, so a replay is reproducible |
| `sessionId` | string | one piece of work is one session |
| `agent` | string | the product, e.g. `claude-code`. Never a credential |
| `actorType` | `agent` \| `human` \| `automation` | |
| `surface` | `mcp` \| `shell` \| `git` \| `filesystem` \| `network` \| `question` | where it was caught |
| `operation` | string | `github.merge_pull_request`, `rm` |
| `class` | `read` \| `write` \| `destructive` \| `communication` \| `unknown` | |
| `effect` | `allow` \| `ask` \| `deny` | |
| `mode` | `off` \| `observe` \| `advise` \| `enforce` | in force at the time |
| `reason` | string | |

## Optional

| Field | Notes |
|---|---|
| `principal` | whose authority it ran under |
| `target` | a path, a branch, a host. Never a payload |
| `shadowEffect` | what enforce would have said, when the mode stopped it applying |
| `rule` | `{ name, layer, file, line }` — enough to open the file |
| `alternative` | `{ action, resource, note }` |
| `policyHash` | the rule set in force then, not now |
| `argsDigest` | a hash. The arguments never reach a row |
| `execution` | `completed` \| `failed` \| `blocked` \| `timed-out` |
| `exitCode`, `durationMs` | |
| `outputDigest` | a hash of what it printed |
| `authorizedBy` | who released a held call |

## What the schema refuses

- Any field not listed above — drift is caught at the boundary rather than found later.
- A `schemaVersion` that is not 1.
- An enum value outside its set.
- An `at` that is not a timestamp.
- **A digest field longer than 128 characters**, which is the shape of a payload that
  escaped into a field meant to hold a hash.

`validateEvent` returns *every* problem rather than the first, because a caller fixing
one field at a time round-trips forever.

## Storage

SQLite in WAL mode at `~/.memnox/memnox.db`. Append-only enforced by a trigger, not by
convention: the only legal `UPDATE` is recording who released a held call.
