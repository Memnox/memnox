# @memnox/postgres

Postgres implementations of the four runtime storage ports, for deployments that
run more than one instance.

```bash
memnox serve --database-url postgres://localhost/memnox
# or MEMNOX_DATABASE_URL
```

The schema is created on start; there is no separate migration step.

## What it implements

| Port (in `@memnox/core`) | Adapter |
|---|---|
| `IdentityStore` | `PostgresIdentityStore` |
| `ApprovalStore` | `PostgresApprovalStore` |
| `AuditLog` | `PostgresAuditLog` |
| `DecisionStore` | `PostgresDecisionStore` |
| `VectorIndex` (`@memnox/memory`) | `PostgresVectorIndex` |

Nothing else changes. The gateway depends on the ports, so switching backends is
a wiring decision, not a code change.

## When you need it

The file stores are the default and are genuinely sufficient for a single
instance. Reach for Postgres when:

- more than one runtime instance must share approvals and identities,
- the audit log has outgrown a JSONL file, or
- you need SQL access to decision history for reporting.

Pair it with `@memnox/redis` so rate limits and locks are shared too — otherwise
each instance enforces its own.

## Query columns plus a record blob

Each table stores the fields it filters and sorts on as real columns, and the
full record as a codec-encoded blob. Queries stay indexable while the domain type
remains the single source of truth — adding an optional field to a record does
not require a migration.

## Encryption at rest

Every adapter takes a `TextCodec`. The default is plaintext; `--data-key` supplies
an AES-256-GCM codec with a random IV per record.

**Deterministic-IV encryption is banned here.** Pairing it with content search
leaks plaintext relationships through ciphertext equality — a real incident in the
predecessor codebase. If a column must be both encrypted and searchable, the
answer is to not encrypt it, not to make the IV predictable.

## Audit chain integrity

The hash chain is computed in `@memnox/core`, not in SQL. A row altered directly
in the database still fails `AuditChainVerifier` — the database is storage, not
the source of trust.
