# Roadmap — open gaps

Each item names the seam where it plugs in, so contributors can start without spelunking. Convert these to GitHub issues on publish.

## Understanding the action

- [x] **Verified execution** — `runGuarded()` (`@memnox/sdk`) runs preconditions → action → postconditions → rollback, and `POST /v1/actions/outcome` audits what actually happened, so the log records outcomes and not just permissions. The compliance report's verification coverage names the decisions still awaiting testimony (separating "too recent to be overdue" from unreported), and `serve --verification-guard` escalates an agent's destructive actions while its trail stays unverified.

## Policy lifecycle

- [x] **Policy versioning** — `versionPolicySet()` content-hashes a rule set; every audit event carries `policyVersion`, so a decision traces to the exact rules that produced it.
- [x] **Policy simulator** — `memnox policy simulate --from-audit` replays real audit history through a candidate rule set and reports what would change, flagging anything that becomes *more* permissive.
- [x] **Policy packs** — five starter packs (`memnox policy packs` / `install`), name-collision safe and idempotent. Open: no remote/community registry — packs ship in-tree.

## Storage & scale (highest priority)

- [x] **Persistent approvals** — pending approvals die with the process. Implement `JsonFileApprovalStore` against the existing `ApprovalStore` port (`packages/core/src/ports/stores.ts`), mirroring `json-file-identity-store.ts`.
- [x] **Postgres adapters** — `@memnox/postgres` implements all four storage ports (query columns + codec-encoded record blobs); enable with `serve --database-url` or `MEMNOX_DATABASE_URL`. Multi-instance/HA deployments share one database; file stores remain the zero-infrastructure default.
- [x] **Distributed locks/cooldowns** — `LockService` port in core (+ `InProcessLockService` default) and `@memnox/redis` adapter ported from the legacy `RedisLockService` with its fail-closed/fail-open asymmetry and Lua atomic increment intact.
- [x] **Approval TTLs** (7-day lapse; expired pending ≠ consent) — approvals never expire; add `expiresAt` + sweep in `packages/runtime/src/action-gateway.ts`.
- [x] **Encryption-at-rest option** (`--data-key`, AES-256-GCM random-IV via TextCodec port) for the JSON/JSONL stores (do NOT pair deterministic-IV encryption with content search — see ARCHITECTURE.md).

## Identity & auth

- [x] **Agent authentication** — bearer tokens, HS256 service-account JWTs (`--agent-jwt-secret`), and mTLS client certificates (`--tls-cert/--tls-key/--tls-ca`). OAuth device flow is still open.
- [~] **Agent owners & organizations** — `orgId` ships; `ownerId` is still open (`packages/core/src/domain/agent-identity.ts`). Credential rotation ships as `POST /v1/agents/:id/rotate`.
- [ ] **Workspace scoping** — container-tag-style hard isolation per workspace (supermemory's model); today the runtime is single-tenant.

## Interception adapters (one thin repo each on publish — see Publication layout)

- [x] **Framework wrappers** — `governTool` / `governTools` (`@memnox/sdk`) wrap any function-calling registry, covering OpenAI Agents SDK, Codex, LangGraph, and CrewAI without a package each.
- [ ] **Java SDK** — port `sdks/go/memnox.go` (the simplest reference client).

## Governance features

- [x] **Approval quorum and time windows** — `minApprovals` gives the two-person rule; `match.windows` scopes a policy to recurring wall-clock windows with the instant passed into evaluation so replay stays reproducible.
- [x] **Semantic decision search** — `DecisionSemanticSearch` fuses keyword and embedding results; BYOK embeddings via `--embedding-key`, degrading to keyword when unavailable.
- [x] **Intent classification** — `memnox intent "<goal>"` expands a stated goal into candidate actions, each rated by the deterministic classifier rather than the model.
- [x] **Search over decisions** — deterministic keyword search, with hybrid embedding retrieval layered on top behind the same signature.
- [x] **Compliance export formats** (audit CSV evidence export) — SOC2/ISO evidence packaging beyond the current markdown/JSON report (`packages/runtime/src/reporting.ts`).

## Distribution

- [ ] Publish `@memnox/*` to npm *(external: registry credentials)*, `memnox` to PyPI, tag for Go modules.
- [x] Dockerfile + docker-compose for the runtime.

## Publication layout (modeled on github.com/supermemoryai)

Supermemory's structure: one flagship engine monorepo (`supermemory`, 28.6k★, MIT) + a thin repo per agent surface (`claude-supermemory`, `cursor-supermemory`, `opencode-supermemory`, `codex-supermemory`, `supermemory-mcp`) + separate SDK repos (`sdk-ts`, `python-sdk`, Apache-2.0, auto-generated) + a benchmark (`memorybench`) + a starter template (`infinite-chat`). The per-surface repos are the adoption engine — each meets one community where it lives.

Planned Memnox equivalent:

| Repo | Contents | Source today |
|---|---|---|
| `memnox-runtime` (flagship) | this monorepo | as-is |
| `memnox-mcp-firewall` | standalone firewall binary | extract `packages/mcp-firewall` |
| `memnox-sdk-python` / `-go` / `-java` | SDK repos | extract `sdks/*` |
| `governed-agent-template` | starter showing a fully governed agent | new |

Keep the packages developed here in the monorepo; the split repos are publish-time mirrors (subtree or copy) so the community finds them where they search.
