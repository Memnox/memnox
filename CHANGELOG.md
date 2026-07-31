# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Until 1.0.0, minor versions may contain breaking changes; they will always be
listed under **Changed** with a migration note.

## [Unreleased]

### Added

- `GET /v1/approvals/:id` — a blocked agent can poll the approval it raised, so the
  require-approval loop closes without an admin token. Readable by that agent or an
  API principal; 403 for any other agent. Exposed as `client.approvalStatus(id)` and
  `memnox approvals status <id>`.
- `GET /v1/agents/:id` — one agent's identity and trust score, without its token hash.
- `HttpTransport` option on `MemnoxClient` — supply your own `fetch` for proxies,
  custom agents, or tests.
- `FirewallSession` and the `CallAuthorizer` port in `@memnox/mcp-firewall`:
  MCP routing and authorization are now independent of the child process, so both
  can be driven directly.
- npm publish metadata and a tag-triggered release workflow with provenance.
- `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue and pull-request templates, and a
  README for every package.
- `npm run test:coverage`.

### Changed

- `MetricsRegistry` takes its counter catalog as a constructor argument and is
  generic over the metric name: `new MetricsRegistry(MY_CATALOG)`. Existing callers
  are unaffected — the no-argument form still exposes the runtime's own counters.
  Exported as `MetricCatalog<N>`.

- CLI commands take a `CliContext` instead of reaching for `console` and building
  their own client. `console.*` now appears only in `ConsoleOutput` and the entry
  point.
- Commands with their own ambient dependency now take it as a defaulted parameter:
  `ci` a `DiffSource`, `serve` a `ServerLauncher`, `protect` an `EditorHookInstaller`,
  `hook` a `HookHost`, and `explain`/`draft`/`intent` an `LlmProviderFactory`.
- `memnox policy simulate` reads audit history through `MemnoxClient` instead of its
  own `fetch` call, so it no longer duplicates base-URL and admin-token handling.
- `memnox audit verify` throws on a broken chain rather than setting `process.exitCode`
  directly, so every command fails through one path.

### Fixed

- `memnox audit verify --url` was ignored: `audit` and `audit verify` both declared
  `--url`, so commander bound the flag to the parent and the subcommand fell back to
  its own default host. Verification always ran against `127.0.0.1:7466` regardless
  of the flag. The subcommand now reads the parent's connection flags.
- The MCP firewall silently dropped an authorized `tools/call` when the wrapped
  server had exited — `child?.stdin?.write()` returns false rather than throwing, so
  the client hung forever. Drops are now logged and answered with an `isError` result.

## [0.1.0]

Initial release.

### Added

- Deterministic policy engine: allow / block / require-approval on a named action,
  with no LLM in the decision path.
- Action gateway pipeline — identity, policy, advisors, approval, audit — composed
  from `AgentRegistry`, `ApprovalService`, and `ActionGateway`.
- Hash-chained, tamper-evident audit log with `memnox audit verify`.
- Approval workflow: quorum (`minApprovals`), TTLs, consent bound to an action
  fingerprint, and audited break-glass overrides.
- Agent identity: bearer tokens, HS256 service-account JWTs, mTLS client
  certificates, and credential rotation.
- Storage ports with two implementations each — local files (zero infrastructure)
  and `@memnox/postgres` / `@memnox/redis` for multi-instance deployments.
- Advisors: taint tracking, behavioral signals, trust scoring, decision memory,
  blast radius (`@memnox/code-graph`), and dependency governance (`@memnox/risk`).
- Content shield — secret and PII scanning on written content and in CI.
- MCP firewall: a transparent stdio proxy that gates `tools/call` and filters
  `tools/list`.
- Editor hooks for Claude Code and Cursor, plus `governTool` / `governTools` for
  function-calling frameworks.
- TypeScript, Python, and Go SDKs.
- `trust-bench` — a 10-scenario governance benchmark.
