# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Until 1.0.0, minor versions may contain breaking changes; they will always be
listed under **Changed** with a migration note.

## [Unreleased]

### Added

- **Rules without YAML.** `memnox ui` (also `memnox policy ui`) opens the policy file in a
  local browser editor: a form per rule, the effect as a picker, patterns as chips, live
  validation through the same `validatePolicyDocument`, a preview of the exact YAML that
  will be written, packs installable in a click, and the simulate panel replaying real
  audit history against what you have edited. Saving writes the policy file, so a rule
  authored in the browser still arrives in a reviewable diff — comments in the file are
  not carried over, and time windows are kept as written. The server binds `127.0.0.1`
  only, rejects any request arriving under another hostname, and requires a per-run
  session token on every API call. It needs no runtime; one is used only to give the
  simulate panel history to replay.
- **Ask before you act.** `POST /v1/context` answers *"what governs this action?"* before
  the action is attempted, instead of the agent discovering the rules by being refused.
  Returns the declared constraints that apply plus a plain-text rendering an agent can
  carry in its context. Records nothing and creates no approval. Exposed as
  `client.context(request)`, `gateway.brief(token, request)`, and
  `memnox context <action> [target]` (`--json` for the structured briefing).
- **A shipped security baseline.** `securityRequirementsFor(action, target)` in
  `@memnox/content-shield` returns the deterministic security requirements for a class
  of work — auth/authz/session, upload handling, endpoints, SQL, XSS, deserialization,
  crypto, shell injection, supply chain, data export, migrations, and deploy secrets.
  A lookup table, not a model: same input, same requirements, same order. Stamped with
  `SECURITY_BASELINE_VERSION` so a briefing is reproducible. Surfaced in every briefing,
  listed separately from the constraints an organization declared.
- **Memnox as an MCP server.** `memnox mcp` speaks MCP over stdio and exposes two tools:
  `memnox_check_rules` (the briefing) and `memnox_status`. `memnox mcp install [client]`
  registers it with Claude Code and Cursor; `memnox mcp uninstall <client>` removes it.
  An existing `memnox` entry is never overwritten.
- **`Dockerfile.allinone`** — Memnox and Graphify in one image, so a deployment needs no
  host Python. Builds the code graph from a read-only `/repo` mount on start and serves
  with `--code-graph` already pointed at it. Runs unprivileged, keeps every write inside
  `/data`, pins `GRAPHIFY_VERSION`, and ships `docker/THIRD-PARTY-NOTICES.md` as
  Apache-2.0 section 4 requires. The default image is unchanged and contains no Graphify.
- **Graphify as an optional code-understanding backend.** `memnox graphify
  install | status | build | use` installs it (uv, pipx, or pip3), re-extracts the graph
  through the AST-only `update --no-cluster` path — no LLM, no network, no API key — and
  converts `graphify-out/graph.json` into the snapshot the runtime already loads.
  `memnox setup` prefers a Graphify graph when one exists and falls back to the built-in
  walker otherwise. Only `EXTRACTED` edges are read; `INFERRED` ones are counted and
  discarded, so nothing model-derived reaches a decision. On a real Next.js monorepo this
  raised reachability from 222 edges to 767. `graphifyToSnapshot` is in
  `@memnox/code-graph`, with the upstream schema pinned in a test.
- `memnox status` — one call for whether the runtime is up, which rules are in force,
  what is waiting on a human, and how many decisions were withheld by monitor mode.
  That last number is what says whether `--enforce` is safe yet.
- `memnox approve <id>` and `memnox deny <id>` as top-level commands; `--by` defaults to
  `$USER`. `memnox approvals` with no subcommand lists pending approvals.
- `memnox simulate [file]` and `memnox reload` as top-level commands.
- `memnox check [action] [target]` accepts its subject positionally, and resolves the
  agent token and runtime URL from `MEMNOX_AGENT_TOKEN`/`MEMNOX_URL` or the config
  `memnox setup` wrote, so neither `--token` nor `--url` is needed for local use.
- Coloured CLI output for decision effects and risk levels, honouring `NO_COLOR` and
  `FORCE_COLOR`. Piped output is unchanged — colour appears only on a terminal.
- `memnox check` prints a `Withheld:` line when monitor mode kept a verdict from being
  applied, so an observed block is visible rather than looking like a plain allow.
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

- **`memnox setup` now gives a local install every deterministic guard, and registers the
  MCP server.** `behaviorGuard`, `trustGuard`, `verificationGuard`, and `dependencyGuard`
  were off by default, and nothing registered Memnox with an MCP client — so the shipped
  security baseline was installed but nothing ever asked for it, which looks exactly like
  having no baseline. Setup now launches with all four on, registers the server with every
  detected client, and prints the guard list. Safe because a first run observes: a guard
  that fires is an audit line, not a blocked editor. `--no-mcp` skips the registration.
  **`memnox serve` is unchanged** — a server deployment keeps its explicit-flag contract
  and does not silently gain three audit queries per request because a local default moved.
- `memnox setup` builds the code-graph snapshot and starts the runtime with
  `--code-graph` pointed at it. Blast radius previously needed two manual steps
  (`memnox graph build`, then `serve --code-graph`), so in practice it was off. Failure
  to walk a repository is non-fatal — an ungraphable repository still gets a governed
  editor. `--no-graph` opts out.
- **A granted approval is now claimable by fingerprint, and is single-use.** The gateway
  used to consult an approval only when the request carried an `approvalId`. Neither the
  editor hook nor the MCP firewall can produce one — both build their request from a tool
  call — so an approved action re-raised a fresh hold on every retry and never proceeded.
  A grant matching the request fingerprint (`agent | action | target | environment`) is
  now claimed on the require-approval path and marked `consumedAt`, so one grant
  authorizes one action. **Migration:** records written before this have no `consumedAt`
  and stay reusable rather than retroactively failing closed. `ApprovalStore` gains
  `findGrantedByFingerprint`; custom adapters must implement it.
- Capability bounds, suspension, and non-overridable taint blocks all still outrank a
  grant, and leave it unspent — covered by `grant-precedence.test.ts`.
- `memnox policy simulate` no longer takes `--from-audit`; replaying real history is the
  only mode, so the flag had one useful value. `--against` defaults to the policy file in
  the working directory instead of "no policies".
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

- An approved action could never proceed through an editor hook or the MCP firewall.
  See **Changed** above — this is the behaviour change that repairs it.
- The same policy file was loaded twice when it reached the runtime by two spellings of
  one path. `memnox setup` passes the file relatively and registers it absolutely, and
  the source list deduplicated the strings rather than the resolved paths, so every rule
  in it matched twice and appeared twice in `matchedPolicies`. Sources are now resolved
  to absolute paths before deduplication.
- `memnox check` could not see project-scoped rules. The command had no way to declare a
  project, so `PolicyEngine.inScope` rejected every rule from a file with a `project:`
  key — the CLI reported "no policy matched" while the runtime held a matching `block`.
  It now sends the project the working directory declares, overridable with `--project`.
- `memnox policy simulate` reported a confident "no action would be decided differently"
  for exactly the rule sets `memnox setup --project` writes. `SimulationCase` carried no
  `projectId`, so project-scoped rules matched nothing. A false all-clear from the tool
  whose job is to warn before a rule change ships.
- `memnox approvals list --url` queried the wrong runtime: the parent and the subcommand
  both declared `--url`, so commander bound it to the parent — the same trap already
  fixed for `audit verify`. Approval subcommands now read the parent's connection flags.
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
