# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Until 1.0.0, minor versions may contain breaking changes; they will always be
listed under **Changed** with a migration note.

## [Unreleased]

## [0.5.1] - 2026-09-01

### Fixed

Found by walking the published 0.5.0 as a new user would.

**`doctor` and `harden` read the project `discover` already showed.** `memnox` named
the repository's own `.env` as reachable and then neither ranked it nor wrote a rule
for it, so the reader was told about a credential and offered no fix.

**`harden --revert <id>` takes only the step it names.** The printed undo carried an id
that was silently ignored, so reverting the Docker rule also removed the credentials
rule without saying so.

**A mistyped command says so.** `memnox audti` ran a full discovery, spawned the MCP
servers it found, and exited 0. Any unrecognised word fell through to the default
command; it now errors and exits non-zero, while bare `memnox` still discovers.

**`setup` declares the seams it installs.** It installed the tool hook and told the
runtime nothing, so `coverage` reported `0/0 seams` on a machine that had one. The list
lives in one place now, so `setup` and `hooks install` cannot drift apart.

**`memnox test` pointed at `describe`**, a command that was merged into `rules`.

**A refusal reads as a sentence.** `GET /v1/agents/levels/readiness failed:
{"error":"no such agent"}` is what an SDK caller wants and not what a person does.

## [0.5.0] - 2026-09-01

### Added

**`@memnox/tool-hook`, the seam that holds an agent's own tools.** The MCP proxy
governs what an agent reaches through a server; this governs what it does directly
— `Read`, `Write`, `Edit`, `Bash`, `WebFetch` — which is most of what a coding
agent does. Install it with `memnox hooks install`, or let `memnox setup` do it
(`--no-hooks` to skip). `memnox hooks status` prints what it sees and what it is
blind to.

The seam never answers `allow` to the host: that would skip a permission prompt the
person would otherwise have seen. It can withhold, or hand the call to somebody, and
it cannot widen authority.

**Seams declare themselves.** `POST /v1/seams` registers a seam against the agent its
token names, and re-registering is a heartbeat rather than a second row. Both seams
now declare on start, so `coverage` counts what is installed and carries its blind
spots instead of reporting an ungoverned machine.

**MCP servers are enumerated over the protocol.** `NodeMcpLister` starts each server a
config declares and asks it what it holds, so `discover` reports every tool and whether
it reads, writes or destroys. `--no-probe` skips it; what was started is named in the
report, for the same reason the credential scan names what it opened.

**The broker has a surface.** `POST /v1/capabilities` grants by operation, `POST
/v1/leases` exchanges one for a short lease, and `POST /v1/leases/:id/redeem` counts a
use. Grants and leases are now on disk, so a restart cannot hand back authority a kill
had revoked.

**The flight recorder records both directions.** `POST /v1/frames` takes a `tool_call`,
`result` or `side_effect` frame from a seam, with a digest and never a payload. The MCP
proxy and the tool hook both report; the broker writes a `capability` frame with every
lease. `GET /v1/sessions/:id/lineage` assembles the chain, and `memnox replay` prints
it — every hop stating whether it was propagated or only inferred.

**An egress proxy and a Docker socket gate, the last two local seams.**
`memnox-egress` is an HTTP forward proxy: plain requests are ruled on by destination
*and* payload, and a CONNECT tunnel is ruled on by destination alone — the body inside
it is named as a blind spot rather than pretended about, so no TLS interception is
needed and none is done. `memnox-docker` sits in front of the Docker socket and names
each call (`container.exec`, `image.delete`, `docker.read`), because an agent that can
reach that socket can reach the whole host.

Both refuse loudly if they cannot bind. The Docker seam checks the socket path against
the operating system's length cap and confirms the socket is on disk before it
announces itself: `listen` can report success while binding nothing, and a seam
claiming coverage it does not have is the one lie worth crashing over.

**Two more local seams.** `memnox-shell -- <command>` gates a command and then runs it
unchanged; `memnox-git-credential` sits in front of git's real helper and can decline a
remote, never supply one — it holds no secrets and can hand none out. `memnox hooks
install` declares all three, so coverage counts the hook, the shell and git.

The git seam is the one place that deliberately opens when the runtime is unreachable:
it sits in front of every git operation a person performs and can only ever subtract,
so declining to rule leaves the machine as it was rather than breaking every clone on a
network blip. What that gives up is stated in the code and in the log line — a frozen
remote stays reachable until the runtime is back. The hook and shell seams fail closed.

**Egress is checked on destination and payload both.** `inspectEgress` in core is
deterministic and cheap — credential shapes and marked fields, never a classifier — and
runs as an `EgressAdvisor` in the runtime and inline in the local seams. An allowed host
carrying a credential is still a refusal, the refusal names the field and never the
value, and nothing is ever silently stripped.

**Discovery reads the project, not only the home directory.** `.env`, `.env.local`,
`.env.production`, `.npmrc` and the checkout itself, each fingerprinted and never kept.

**`memnox why <id> --counterfactual`** names what a withheld action would have reached,
derived from the attempt that was made and from this machine's own reachability.

### Fixed

**A local refusal now names its alternative.** `LocalGate` resolved the substitute
from the matched rule and then dropped it, so a refusal with no runtime running was
a dead end. Both local seams now carry it through to the agent.

## [0.4.0] - 2026-08-31

Memnox is now built to `VISION.md`, the eleven-phase build sequence. The first
four phases run with no account, no cloud and no network, which is architecture
rather than a free tier.

### Changed

**Three effects, not four.** `block` is now `withhold`, `require_approval` is now
`escalate`, and `redact` is gone. A partial answer is a `withheld` count on the
answer rather than an effect on a decision.

*Migration:* rename the effects in every policy file, and update any caller that
compares an effect string. The TypeScript, Python, Go, Rust, Java and Swift SDKs
all moved with it: `ActionBlockedError` is `ActionWithheldError`,
`ApprovalRequiredError` is `EscalationRequiredError`, `withheldEffect` is
`shadowEffect`, and `blocked` counters are `withheld`.

**Enforcement modes gained a rung.** `monitor` is now `observe`, and `advise`
sits between it and `enforce`. *Migration:* rename `monitor` in
`--enforcement` specs, per-rule `mode:` fields, and stored enforcement maps.

**Authority is a granted level, not a computed score.** `trustScore` and
`--trust-guard` are gone. *Migration:* nothing replaces the flag; use
`memnox readiness <agentId>` to see what an agent needs, and grant a level
deliberately. A number that silently narrowed a permission was unauditable.

**Commands renamed for what they answer.** `context` and `describe` merged into
`rules`; `report` and `compliance` merged into `evidence`; `trace` became
`why --evidence`; `insights` became `coverage`; `suggestions` became `queue`.

### Added

- **`@memnox/discovery`** (§00) — what can act on this machine, what it reaches,
  ranked findings, and reversible harden steps. `memnox`, `memnox doctor`,
  `memnox harden`. Secrets are fingerprinted, never stored.
- **Declared tasks** (§01) — a session states what it was asked for and the scope
  that implies; `match.scope` makes an out-of-scope request a fact a rule matches
  on. Compared, never inferred.
- **`Decision.alternative`** (§01) — what a withholding rule permits instead,
  resolved from the rule and carried into the MCP denial the client reads.
- **`memnox why`** (§01) — five lines built from the same match the verdict came
  from and stored beside it, replacing the model-written `memnox explain`.
- **The MCP proxy checks both directions** (§02) — a tool result is wrapped as an
  untrusted context block, and instruction-shaped content is recorded and quoted
  rather than removed.
- **Capabilities and leases** (§02) — `CapabilityBroker` exchanges a request for a
  lease scoped to one operation and a few minutes. Every lease is a decision.
- **`@memnox/ledger`** (§03, §09) — frames with hashed payloads, usage against
  grant, unused grants, lineage with a method on every hop, counterfactuals,
  coverage, drift, chain findings, cost ceilings and incidents.
- **`memnox learn`** (§03) — a window of real work becomes a policy file in the
  format a person writes, with the sample size in the file itself.
- **The census** (§04) — every agent from every source, each with the record that
  proved it exists, and the sources that could not be read.
- **Delegation and containment** (§06) — chains that only narrow, checked at issue
  and again at use; `memnox kill`, `quarantine` and `panic`, each naming every
  machine it did not reach.
- **State facts** (§07) — the company's current condition as a policy input, with
  a mandatory expiry, distributed inside the bundle.
- **`@memnox/workflow`** (§08) — a durable engine, and the invariant that every
  route to a delegation passes a decision or an approval.
- **`@memnox/autonomy`** (§10) — named levels a person grants, and readiness as
  queries against stores that exist.
- **`memnox agents assign <id> --owner <person>`** — names who answers for an
  agent, which is the edge every escalation resolves through.

### Removed

**A model never explains a decision or infers intent.** `DecisionExplainer` and
`IntentClassifier` are gone, with `memnox explain` and `memnox intent`. An
explanation written afterwards by a model is a plausible story about a decision;
intent arrives as a declared task instead.

- `memnox plan` and the action-plan file format.
- `memnox ui` and the browser policy editor.
- `memnox quickstart`, which duplicated `memnox setup`.
- The plan-step scoping mechanism, replaced by declared tasks.



**Code understanding, in full.** Memnox is the organizational runtime: it holds an
organization's operating model and rules on the actions agents propose. Reading a
repository was a second product living inside the first, so it is gone rather than
deprecated.

- **`@memnox/code-graph`** — the import graph, `BlastRadiusAdvisor`, and blast-radius
  escalation. With it go `memnox graph`, `memnox graphify`, `serve --code-graph`,
  `serve --protected-path`, and the `codeGraphFile` / `protectedPaths` config fields.
- **`@memnox/content-shield`** — the offline secret/PII scanner, `ContentShieldAdvisor`,
  the curated vulnerable-package table, and the shipped security baseline. With it go
  `memnox ci`, `serve --no-content-shield`, the proxy output guard and its
  `memnox_proxy_output_blocked_total` metric, the local gate's secret scanning and
  redaction (`MEMNOX_ON_SECRET`, `SECRET_RESPONSE`), and the `security` /
  `securityBaseline` fields of an action briefing. `POST /v1/context` now returns
  declared constraints only.
- **`@memnox/trust-bench`** — the governance benchmark.
- **Editor integration** — `memnox hook`, `memnox protect`, `EditorHookInstaller`, the
  Claude Code and Cursor hook mappings, and `quickstart`'s `[agent]` argument and
  `--no-hook` flag. Agents reach the runtime through the MCP server, the SDKs, or the
  REST API.
- **`DependencyAdvisor`** (`@memnox/risk`) and its `LicenseResolver` port, with
  `serve --dependency-guard` and `--dependency-license-lookup`.
- **`Dockerfile.allinone`**, `docker/entrypoint-allinone.sh`, and the Graphify
  integration they existed to carry.

### Added

- **Memnox as an MCP server.** `memnox mcp` speaks MCP over stdio and exposes two tools:
  `memnox_check_rules` (the briefing) and `memnox_status`. `memnox mcp install [client]`
  registers it with Claude Code and Cursor; `memnox mcp uninstall <client>` removes it.
  An existing `memnox` entry is never overwritten.
- `memnox status` — one call for whether the runtime is up, which rules are in force,
  what is waiting on a human, and how many decisions were withheld by observe mode.
  That last number is what says whether `--enforce` is safe yet.
- `memnox approve <id>` and `memnox deny <id>` as top-level commands; `--by` defaults to
  `$USER`. `memnox approvals` with no subcommand lists pending approvals.
- `memnox simulate [file]` and `memnox reload` as top-level commands.
- `memnox check [action] [target]` accepts its subject positionally, and resolves the
  agent token and runtime URL from `MEMNOX_AGENT_TOKEN`/`MEMNOX_URL` or the config
  `memnox setup` wrote, so neither `--token` nor `--url` is needed for local use.
- Coloured CLI output for decision effects and risk levels, honouring `NO_COLOR` and
  `FORCE_COLOR`. Piped output is unchanged — colour appears only on a terminal.
- `memnox check` prints a `Shadow:` line when observe mode kept a verdict from being
  applied, so an observed block is visible rather than looking like a plain allow.
- `GET /v1/approvals/:id` — a blocked agent can poll the approval it raised, so the
  require-approval loop closes without an admin token. Readable by that agent or an
  API principal; 403 for any other agent. Exposed as `client.approvalStatus(id)` and
  `memnox approvals status <id>`.
- `GET /v1/agents/:id` — one agent's identity and granted level, without its token hash.
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
  MCP server.** `behaviorGuard` and `verificationGuard` were off by default, and nothing
  registered Memnox with an MCP client, so a guard could be installed with nothing ever
  asking for it. Setup now launches with them on, registers the server with every
  detected client, and prints the guard list. Safe because a first run observes: a guard
  that fires is an audit line, not a refused editor. `--no-mcp` skips the registration.
  **`memnox serve` is unchanged** — a server deployment keeps its explicit-flag contract
  and does not silently gain audit queries per request because a local default moved.
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

## [0.3.1] - 2026-08-28

### Fixed

- **`memnox setup` could not start a runtime once any registered policy file went
  missing.** `~/.memnox/policies.json` only ever grows, and loading it treated a
  vanished path as fatal, so deleting a policy file in one repository broke setup
  in *every other project on the machine* — reporting a directory the user was not
  working in. A path a run names itself is still fatal, because a typo has to be
  loud; a path another repository registered is now skipped with a warning naming
  the file. A registered file that is present but malformed still fails.
- `memnox --version` reported `0.2.0`, unchanged since the 0.3.0 release.

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
