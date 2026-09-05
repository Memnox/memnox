# Memnox — Build Plan: Milestones and Developer Tasks

**From empty repo to live product, for the open-source runtime and the closed-source cloud**

> Companion to `memnox-functional-spec.md`. Section numbers like *spec §2.4* point there.
> Stack choices are **[proposed]** — Memnox already ships on npm (`npx memnox`), so the plan assumes TypeScript/Node throughout to keep one language across OSS and cloud.

---

## 0. How to read this plan

### 0.1 Task format

Every task is sized for one junior developer with a reviewer, **0.5–3 days**, and has:

```text
ID        OSS-1.3 / CLD-4.2
Goal      one sentence
Deliver   the artifact (file, command, endpoint, table)
Accept    checkable acceptance criteria
Depends   task IDs that must be merged first
Size      S (≤1 day) · M (1–2 days) · L (2–3 days)
```

If a task looks bigger than L while you're doing it, stop and split it — that is expected, not a failure.

### 0.2 Definition of done (applies to every task)

- Code merged to `main` through a PR with one approving review.
- Unit tests for new logic; an integration test when a command or endpoint is added.
- `README`/docs updated if a user-visible command, flag, file, or endpoint changed.
- No new dependency without a one-line justification in the PR.
- Nothing writes outside `~/.memnox/` or `<project>/.memnox/` (OSS) unless the task says so and a backup is taken.
- No LLM call on any enforcement path. Ever.

### 0.3 Proposed stack **[proposed]**

| Layer | Choice | Why |
|---|---|---|
| OSS CLI/daemon | TypeScript, Node ≥ 20, pnpm workspace, `commander`, `better-sqlite3`, `@modelcontextprotocol/sdk`, `chokidar`, `vitest` | Already on npm; single-binary via `pkg`/`bun build` later |
| OSS repo layout | `packages/core` (engine, store), `packages/cli`, `packages/proxy`, `packages/interceptors` | Lets cloud reuse `core` |
| Cloud API | TypeScript, Hono (or Fastify), Postgres, Drizzle ORM, BullMQ (Redis) for jobs | Boring, fast, small |
| Cloud web | Next.js app router, Tailwind | Dashboard only; CLI stays primary |
| Auth | WorkOS or Auth.js with SSO (Google, GitHub, SAML later) | Enterprise SSO without building it |
| Infra | Fly.io or Railway + managed Postgres; Cloudflare in front | One person can operate it |
| Connectors | GitHub App, Slack App, Jira/Linear OAuth, Google Drive, PagerDuty/incident.io webhooks | |

### 0.4 Milestone map

```text
OSS (open source, Apache-2.0)                  CLOUD (closed source)
────────────────────────────────               ─────────────────────────────────
M0  Foundation                                  C0  Foundation (auth, tenancy, ingest)
M1  scan                                        C1  Enrollment + sync   ◄── needs M6
M2  explain + diff                              C2  Agent inventory
M3  protect (policy engine)                     C3  Central policies    ◄── needs M3
M4  MCP proxy                                   C4  Routed approvals    ◄── needs M4/M5
M5  Shell / git / fs / network interception     C5  Graph + who + effective capability
M6  Event store + why + timeline                C6  Org context connectors + overlays
M7  watch + sessions + limits + conflicts       C7  Decisions + organizational answer + suggestions
M8  Hardening + OSS go-live                     C8  Gap analysis + authority over time
                                                C9  what-if simulation
                                                C10 Audit, export, billing
                                                C11 Cloud go-live
```

M9 and M10 hang off M5–M7 rather than extending the chain: recovery needs the interception seam, and leases need sessions.

OSS is strictly sequential through M8 (each milestone is the demo for the next). Cloud C0 can start once M6's event schema is frozen; C1 onward needs a working OSS runtime to sync from.

### 0.5 Code conventions

Three rules, enforced in review, in OSS and cloud alike.

**1. No `any`.** Use `unknown` and narrow at the boundary. Every method declares its
return type, async included. An `as` cast carries a one-line reason. `any` is a change
request rather than a nit: it is how an untrusted MCP payload becomes a trusted object
with nobody noticing.

**2. DDD layering.** Dependencies point one way — interface → application → domain —
and infrastructure implements ports the domain defines. Never import another package's
internals, only its `index.ts`.

| Layer | Lives in | Holds |
|---|---|---|
| interface | `packages/cli` commands, `packages/proxy` JSON-RPC, `packages/interceptors` argv wrappers | transports: validate shapes, map outcomes to exit codes and MCP errors, nothing else |
| application | the evaluate → sink → approval-hold path | orchestration and invariants; owns the pipeline |
| domain | `packages/core`: `inventory`, `classify`, `risk`, `diff`, `event`, the policy engine | pure types, constants, deterministic logic, zero runtime deps |
| infrastructure | `packages/core/store` (SQLite), config reader, manifest cache | adapters behind domain ports |

A command holds no logic. When one grows past shape-checking and rendering, the logic
moves to the domain and the test moves next to it.

**3. Comments are one line and say WHY.** Never restate the code, never leave a
commented-out block, never open a file or a section with a banner. A reason belongs on
the line it explains; anything longer belongs in `docs/`, where it is read on purpose.

```ts
// WRONG — a banner, and it restates the function below
/* =====================================================
 *  Tool classifier — maps tool names to read / write /
 *  destructive using the verb table. See OSS-1.7.
 * ===================================================== */

// RIGHT
// Annotations win over the verb table: the server author knows the tool better than we do.
```

---

# PART A — OPEN SOURCE RUNTIME

## M0 — Foundation (≈ 1 week)

**Milestone demo:** `npx memnox --version` works from a fresh clone; CI is green; a hello-world command writes to `~/.memnox/`.

| ID | Goal | Deliver | Accept | Depends | Size |
|---|---|---|---|---|---|
| OSS-0.1 | Create pnpm monorepo | `packages/core`, `packages/cli`, `packages/proxy`, `packages/interceptors`, root `tsconfig`, `vitest` | `pnpm test` runs an example test in each package | — | S |
| OSS-0.2 | CLI skeleton | `memnox` bin with `commander`, `--version`, `--json` global flag, `--help` | `npx memnox --help` lists placeholder subcommands | 0.1 | S |
| OSS-0.3 | Home directory + config | `~/.memnox/config.toml` created on first run with `mode = "observe"` | Running twice does not overwrite; `memnox config get mode` prints `observe` | 0.2 | S |
| OSS-0.4 | Logger + output renderer | `core/render`: table/tree/plain renderers; `--json` bypasses renderers | Snapshot tests for each renderer | 0.2 | S |
| OSS-0.5 | CI pipeline | GitHub Actions: lint, typecheck, test on macOS + Ubuntu, Node 20/22 | Badge green on `main` | 0.1 | S |
| OSS-0.6 | Release tooling | changesets + `npm publish` dry-run job; `CONTRIBUTING.md`; PR template | Tag → dry-run publish succeeds | 0.5 | S |
| OSS-0.7 | Fix public-surface bugs already known | README issues link → correct repo; hero command becomes `npx memnox` (not `setup`); remove fictional-company demo CTA | Links resolve; homepage shows the discovery command | — | S |

---

## M1 — `memnox scan` (≈ 2 weeks) — spec §2.1, §2.2

**Milestone demo:** on a real laptop with Claude Code + 2 MCP servers, `memnox scan` prints the capability tree with correct read/write counts and lists `~/.ssh` as readable. This is WOW 1; nothing else matters until it's true.

| ID | Goal | Deliver | Accept | Depends | Size |
|---|---|---|---|---|---|
| OSS-1.1 | `CapabilityInventory` type | `core/inventory.ts`: agents[], mcpServers[], tools[], filesystem[], shell, git[], credentials[], network; JSON schema | Type + schema exported; fixture round-trips | 0.4 | S |
| OSS-1.2 | Agent detector: Claude Code | Read `~/.claude/settings.json`, project `.claude/`, permission mode, bypass flag | Unit tests with 3 fixture configs (default, allow-list, bypass) | 1.1 | M |
| OSS-1.3 | Agent detector: Cursor | Same for Cursor's MCP/config paths | Fixture tests | 1.1 | M |
| OSS-1.4 | Agent detector: Codex + generic | Codex config; generic `.mcp.json` fallback | Fixture tests | 1.1 | M |
| OSS-1.5 | MCP config parser | Normalize stdio/HTTP server entries from all detectors into `mcpServers[]` with env var **names** | Secrets never appear in output (test asserts) | 1.2–1.4 | S |
| OSS-1.6 | MCP handshake client | Spawn/connect each server, `initialize` + `tools/list`, 5 s timeout, cache to `~/.memnox/manifests/<server>.json` | Works against the reference filesystem MCP server; timeout produces `unreachable`, not a crash | 1.5 | L |
| OSS-1.7 | Tool classifier v1 | `core/classify.ts`: annotations (`readOnlyHint`, `destructiveHint`) → verb table (`get_/list_/search_` read; `create_/update_/merge_/send_/post_` write; `delete_/remove_/force_/refund_/drop_` destructive) → `communication` for message-like tools | Table-driven tests, ≥ 40 tool names; overrides file supported | 1.6 | M |
| OSS-1.8 | Filesystem probe | Check readability/writability of sensitive path list (`~/.ssh`, `~/.aws`, `~/.gcloud`, `~/.kube`, `.env*`, keychain dirs) as current user; list writable roots from cwd | Reports `readable/writable/none` per path; never reads file contents | 1.1 | M |
| OSS-1.9 | Shell + git probe | Shell enabled?; git remotes, credential helper present, token env names | Fixture repo tests | 1.1 | S |
| OSS-1.10 | Network probe | Proxy env, sandbox flags, quick egress check (DNS resolve only, no request) | Reports `outbound: detected/restricted/unknown` | 1.1 | S |
| OSS-1.11 | Risk band rule table | `core/risk.ts`: fixed rules → `LOW/MEDIUM/HIGH`, returns the rules that fired | Table documented in `docs/risk-bands.md`; tests per rule | 1.7, 1.8 | S |
| OSS-1.12 | `scan` command + tree renderer | Compose probes → inventory → render tree with counts ("6 capabilities can change external state", "`~/.ssh` readable by N agents") | Manual run on a real machine matches expectations; `--json` outputs the inventory | 1.2–1.11 | M |
| OSS-1.13 | `--save` snapshots | Write `~/.memnox/scans/<ts>.json`; keep last 30 | `memnox scan --save` twice → two files | 1.12 | S |
| OSS-1.14 | `scan --mcp <server>` review view | Tools split read/write, filesystem/network/credential reach, risk band | Output matches spec §2.1 MCP review block | 1.12 | S |
| OSS-1.15 | Scan performance + resilience | Parallel handshakes, total run < 10 s with 5 servers; broken server never aborts scan | Timed test; chaos test with a hanging server | 1.6 | M |

---

## M2 — `memnox explain` + `memnox diff` (≈ 1 week) — spec §2.3, §2.7

**Milestone demo:** `memnox explain refund_payment` prints the provenance chain; add an MCP server, run `memnox diff`, see it listed.

| ID | Goal | Deliver | Accept | Depends | Size |
|---|---|---|---|---|---|
| OSS-2.1 | Provenance index | Map every capability back to `{agent, configFile, addedAt (file mtime / git blame if available)}` | Inventory entries carry `source` | 1.12 | M |
| OSS-2.2 | `explain <capability>` | Resolve arg to tool / path / server / agent; print chain + class + governing policy (none yet) | 4 fixture cases | 2.1 | M |
| OSS-2.3 | Question grammar | Parse `can <agent> <verb> <resource>` with a small synonym table (deploy, merge, push, read, write, delete, send) | Parser tests; unknown phrasing → helpful usage message, never a guess | 2.2 | M |
| OSS-2.4 | `explain "<question>"` (local rows) | Answer `Technically` and `Runtime permissions` rows from inventory; `Policy` row from M3 once available | Works on `"can claude read ~/.aws"` | 2.3 | S |
| OSS-2.5 | Snapshot differ | `core/diff.ts`: added/removed/changed servers, tools, credentials, paths, permission mode | Pure-function tests | 1.13 | M |
| OSS-2.6 | `diff` command | `--since yesterday`, `--from/--to`, default = last two snapshots; render `+ Slack MCP / + 8 tools / READ → READ+WRITE` | Matches spec §2.7 output | 2.5 | S |
| OSS-2.7 | `diff --fail-on` | `write-capable`, `credential`, `any` → non-zero exit for CI | CI example in docs | 2.6 | S |

---

## M3 — `memnox protect` + policy engine (≈ 2 weeks) — spec §2.4

**Milestone demo:** `memnox protect --from-scan` writes a sensible `.memnox/policy.toml`; `memnox policy test "git push --force origin main"` prints `DENY` with the rule and file line. Nothing is enforced yet — the engine is proven standalone first.

| ID | Goal | Deliver | Accept | Depends | Size |
|---|---|---|---|---|---|
| OSS-3.1 | Policy schema + parser | TOML → typed `Policy` (filesystem, shell, git, mcp, network, schedule, limits); validation errors with line numbers | 10 valid + 10 invalid fixtures | 0.4 | M |
| OSS-3.2 | Matchers | Glob for paths; command pattern matcher; tool pattern (`server.tool`, wildcards); host matcher (`*.example.com`, CIDR) | Table tests for each | 3.1 | M |
| OSS-3.3 | Command classifier for shell | Parse a shell line into argv (+ pipes); classify `destructive`, `network`, `package-install`, `normal` | ≥ 50 command fixtures incl. `rm -rf`, `dd`, `curl \| sh`, `git push --force` | 3.2 | M |
| OSS-3.4 | Decision engine | `evaluate(action, policyStack) → {decision, rule, layer, file, line, reason, alternative}`; order deny > ask > allow > default; most-specific wins | Property tests: deny always beats allow; default differs by mode | 3.1–3.3 | L |
| OSS-3.5 | Layer stacking | org (placeholder) → user → project; `locked` domains can only tighten | Tests where project tries to loosen a locked org rule | 3.4 | M |
| OSS-3.6 | Schedule rules | `when = "Fri 16:00-23:59"` evaluated in local tz | Tests with frozen clock | 3.4 | S |
| OSS-3.7 | Alternative text | Rule `alternative` field + defaults per class (force-push → "push a branch and open a PR") | Every DENY has non-empty alternative (test) | 3.4 | S |
| OSS-3.8 | `protect --from-scan` generator | Inventory → baseline policy: deny sensitive paths, ask write MCP tools, deny destructive, allow reads | Generated file passes parser; reviewed by hand once | 3.1, 1.12 | M |
| OSS-3.9 | `protect` interactive | Walk domains, show current decision, arrow keys to change; writes file | Manual test; `--yes` skips prompts | 3.8 | M |
| OSS-3.10 | `protect --edit` / `--observe` / `--enforce` | Open in `$EDITOR`; flip mode in config with confirmation | Mode change logged | 3.9 | S |
| OSS-3.11 | `policy test "<action>"` | Dry-run evaluation with full explanation | Used in README | 3.4 | S |
| OSS-3.12 | Native translation v1 (Claude Code) | `protect --apply-native`: write Claude Code allow/deny lists from policy; backup to `.memnox/backup/` | `--revert-native` restores byte-identical file | 3.8 | M |

---

## M4 — MCP proxy (≈ 2 weeks) — spec §2.5

**Milestone demo:** `memnox mcp wrap` repoints Claude Code's servers; a `merge_pull_request` call is held with `[Allow once] [Deny]` in the terminal; `[Deny]` returns a structured error the agent can read. WOW 5.

| ID | Goal | Deliver | Accept | Depends | Size |
|---|---|---|---|---|---|
| OSS-4.1 | Event type + in-memory sink | `core/event.ts` per spec §6; `EventSink` interface (memory now, SQLite in M6) | Schema test; sink receives events | 3.4 | S |
| OSS-4.2 | Proxy skeleton (stdio) | `memnox mcp-proxy --upstream <cmd>`: forward `initialize`, `tools/list`, `resources/*`, notifications transparently | Passes MCP SDK conformance against reference server | 0.1 | L |
| OSS-4.3 | HTTP/SSE upstream | Same for URL upstreams | Works with a public HTTP MCP server | 4.2 | M |
| OSS-4.4 | Manifest cache + classification in proxy | On `tools/list`, store manifest + classes; honor `mcp.hide` by filtering the list | Hidden tools invisible to the agent | 4.2, 1.7 | S |
| OSS-4.5 | `tools/call` interception | Build action `{surface: mcp, operation: server.tool, args}` → engine → ALLOW forwards; DENY returns MCP error `{policy, reason, alternative}` | Integration test with fixture policy | 4.2, 3.4, 4.1 | L |
| OSS-4.6 | ASK hold + terminal prompt | Hold the call; prompt in the proxy's controlling TTY or via daemon socket (M7); options once / session / deny; timeout → deny | Manual test; timeout test | 4.5 | M |
| OSS-4.7 | Argument redaction | Secret detector (regex set: keys, tokens, JWT, `password=`) applied before storage; keep digest | Test corpus; no raw secret in sink | 4.5 | S |
| OSS-4.8 | `mcp wrap` / `mcp unwrap` | Rewrite each agent's MCP config to route via proxy; backup; unwrap restores | Round-trip byte-identical; supports Claude Code, Cursor, Codex | 4.2, 1.5 | M |
| OSS-4.9 | Proxy latency + robustness | ALLOW path overhead < 5 ms median; upstream crash → error to agent, proxy stays up | Benchmark script committed | 4.5 | M |

---

## M5 — Shell / git / filesystem / network interception (≈ 2–3 weeks) — spec §2.5

**Milestone demo:** with `enforce` on, Claude Code running `rm -rf ./build` is asked, `cat ~/.aws/credentials` is denied with an alternative, `git push --force` is denied, and `curl unknown.example.com` is asked.

| ID | Goal | Deliver | Accept | Depends | Size |
|---|---|---|---|---|---|
| OSS-5.1 | Interceptor runtime | `packages/interceptors`: tiny wrapper that receives argv, calls the engine, then `exec`s the real binary; PATH-prefix dir `~/.memnox/bin` | Wrapper adds < 10 ms; passes through stdin/stdout/exit code | 3.4, 4.1 | L |
| OSS-5.2 | `memnox-shell` | Shell wrapper: parse command line (reuse 3.3), evaluate, exec via user's shell; record exit code + duration + output digest | Works as `SHELL` for Claude Code | 5.1 | M |
| OSS-5.3 | `rm` / `dd` / `curl` / `wget` / `ssh` interceptors | Register in the interceptor dir; classify; evaluate | Each has a test hitting ASK/DENY | 5.1 | M |
| OSS-5.4 | `git` interceptor | Parse subcommand, branch, remote, `--force`; evaluate `git.*` operations | 20 command fixtures | 5.1 | M |
| OSS-5.5 | Git hooks (defense in depth) | Optional `pre-push`/`pre-commit` hooks that call `memnox policy check`; installed by `protect --hooks` | Hook blocks even when the interceptor is bypassed | 5.4 | S |
| OSS-5.6 | Filesystem path checks | Path policy evaluated for file args in the shell interceptor (`cat`, `cp`, editors) and in MCP filesystem tools | `cat ~/.aws/credentials` → DENY event | 5.2, 4.5 | M |
| OSS-5.7 | OS guard (macOS) | Generate a `sandbox-exec` profile from filesystem policy; `protect --os-guard` | Denied path unreadable even by a raw binary | 5.6 | L |
| OSS-5.8 | OS guard (Linux) | Landlock-based restriction when kernel supports it; graceful no-op otherwise | Same test on Ubuntu 22.04+ | 5.6 | L |
| OSS-5.9 | Egress proxy | Local HTTP(S)/SOCKS proxy per session; injected via `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`; evaluate host against `[network]`; record host/port only | `curl allowed.host` passes; unknown host → ASK | 5.1 | L |
| OSS-5.10 | Environment injection | `memnox run -- <agent command>`: sets PATH, SHELL, proxy vars, session id for the child | Documented as the recommended launch | 5.2, 5.9 | M |
| OSS-5.11 | Interceptor conformance suite | One test matrix: (surface × class × mode) → expected decision + event | All green on macOS + Ubuntu CI | 5.2–5.10 | M |

---

## M6 — Event store + `why` + `timeline` (≈ 1.5 weeks) — spec §2.8, §2.9, §5.1–5.2

**Milestone demo:** after a real session, `memnox timeline` shows the ordered actions with exit codes; `memnox why` on the blocked push prints the rule, file line, reason, alternative, evidence. WOW 6.

| ID | Goal | Deliver | Accept | Depends | Size |
|---|---|---|---|---|---|
| OSS-6.1 | SQLite store | `~/.memnox/memnox.db` WAL; migrations; tables `events`, `sessions`, `approvals`, `policy_versions`, `capability_snapshots` | Migration up/down tests; concurrent-writer test (5 processes) | 4.1 | L |
| OSS-6.2 | SQLite `EventSink` | Replace memory sink; append-only guarantees (no UPDATE on `events` except approval status) | Insert 10k events < 2 s | 6.1 | S |
| OSS-6.3 | Policy version tracking | Hash policy stack on load; store; events reference hash | `why` after editing policy still shows the rule in force at the time | 6.1, 3.4 | S |
| OSS-6.4 | `why` command | Last non-allow / by id / `--allowed`; show rule, origin file:line, reason, alternative, local evidence (branch protection, CODEOWNERS presence, sensitive-path list) | Matches spec §2.8 | 6.2, 6.3 | M |
| OSS-6.5 | `timeline` command | Filters `--session --agent --since --only`; grouped by session; `--export jsonl/json` | Spec §2.9 output | 6.2 | M |
| OSS-6.6 | Retention + purge | `retention_days` in config; `memnox purge`; snapshot pruning | Old rows gone after purge; never deletes pending approvals | 6.1 | S |
| OSS-6.7 | Freeze event schema v1 | `docs/event-schema.md` + JSON schema published; version field | Cloud team signs off (unblocks C0) | 6.2 | S |

---

## M7 — `watch`, sessions, limits, conflicts (≈ 2 weeks) — spec §2.6, §2.10–2.13

**Milestone demo:** add a Stripe MCP while `memnox watch` runs → `⚠ NEW MCP SERVER … [Protect]`; run two agents on the same file → `⚠ AGENT CONFLICT`; agent says "tests passed" after a failing `npm test` → warning. WOW 4.

| ID | Goal | Deliver | Accept | Depends | Size |
|---|---|---|---|---|---|
| OSS-7.1 | Daemon + local socket | `memnox daemon` (auto-started by interceptors/proxy); Unix socket / named pipe; RPC for evaluate, prompt, subscribe | Interceptors fall back to the in-process engine if the daemon is absent | 5.1 | L |
| OSS-7.2 | Session manager | Session created from process tree + `MEMNOX_SESSION` env; start/end; capabilities-observed accumulation | Two concurrent agents → two sessions; idle timeout closes | 7.1, 6.1 | M |
| OSS-7.3 | Config watcher | `chokidar` on agent/MCP config paths + 15-min timer → re-scan → diff vs baseline → `capability.*` events | Adding a server triggers an event within 2 s | 7.1, 2.5 | M |
| OSS-7.4 | `watch` command | Live tail of decisions + capability events; inline ASK answering; `[Review] [Protect]` actions open `explain`/`protect --for <server>` | Manual test session recorded | 7.1–7.3 | M |
| OSS-7.5 | Agent update detection | Detect agent version change → re-scan → "BEFORE 12 / AFTER 17 capabilities" event | Fixture test with two versions | 7.3 | S |
| OSS-7.6 | Credential exposure alert | Diff shows a credential name newly visible → high-priority watch event | Test: export new AWS var → event | 7.3 | S |
| OSS-7.7 | Limit enforcer | Counters per session: runtime, tool calls, identical action (surface+normalized args digest); `block` decision + optional SIGTERM | Tests for each counter | 7.2 | M |
| OSS-7.8 | Repeated-violation memory | `violations` table; `why` shows prior attempts; watch shows `⚠ REPEATED VIOLATION` on 3rd | Test across three sessions | 6.1, 6.4 | S |
| OSS-7.9 | Unused authority report | `memnox scan --usage 7d`: granted vs used per server; "3 unused tools can modify external state"; `[Protect unused]` writes ask rules | Counts correct on fixture sessions | 7.2, 3.8 | M |
| OSS-7.10 | Agent-collision + duplicate-work detector | Same file written by two sessions within window; same branch/PR/issue touched by two sessions; `conflict` events; `pause` = gate session to ASK-all | Tests with two synthetic sessions | 7.2 | M |
| OSS-7.11 | Transcript tap | Optional: tee agent stdout to `~/.memnox/transcripts/<session>.log` (local only, retention-bound) | Off by default; documented privacy note | 7.2 | S |
| OSS-7.12 | Claim-vs-evidence matcher | Pattern table (tests passed / deployed / committed / pushed / created X) → check events → `conflict(kind=claim)` | ≥ 20 claim fixtures; zero LLM | 7.11, 6.2 | M |

---

## M8 — Hardening + OSS go-live (≈ 2 weeks)

**Milestone demo:** a stranger installs from the README, runs `npx memnox`, sees their own machine, and can uninstall cleanly. Everything in the three public-surface contradictions is fixed.

| ID | Goal | Deliver | Accept | Depends | Size |
|---|---|---|---|---|---|
| OSS-8.1 | `npx memnox` = scan | Bare command runs `scan`; `setup` removed from the hero | First-run < 60 s | 1.12 | S |
| OSS-8.2 | `memnox uninstall` | Unwrap MCP, revert native, remove interceptors from PATH, offer to delete `~/.memnox` | Machine byte-identical to before (test on VM) | 4.8, 3.12, 5.10 | M |
| OSS-8.3 | `memnox doctor` | Check daemon, interceptors on PATH, proxy wiring, policy validity, DB health; fix hints | Each failure has a fix line | 7.1 | M |
| OSS-8.4 | Security self-review | Threat model doc; verify no secrets in DB/logs; socket permissions 0600; interceptor path-hijack review | Checklist signed off; one external reviewer | all | L |
| OSS-8.5 | Windows support decision | Either WSL-only documented or interceptors/socket ported | Decision recorded in ADR | 5.1, 7.1 | M |
| OSS-8.6 | Docs site | Quickstart, policy reference, command reference, event schema, FAQ ("does it call an LLM?" → no) | Every command has a page | all | L |
| OSS-8.7 | README recording | 2-minute asciinema/GIF: real machine, `npx memnox`, `~/.ssh — 3 agents`, protect, one blocked action, `why` | Embedded at top of README | 8.1 | S |
| OSS-8.8 | Share card | `memnox scan --share` renders a PNG/text card with counts only (no paths, no secrets) | Reviewed for leakage | 1.12 | M |
| OSS-8.9 | Telemetry decision | Opt-in only, counts only, documented; or none | ADR + toggle | 0.3 | S |
| OSS-8.10 | Issue templates + triage labels | Bug/feature templates asking for `memnox doctor` output | Templates live | 8.3 | S |
| OSS-8.11 | 1.0.0 release | Changelog, npm publish, GitHub release, signed tarball | `npx memnox@1` works on clean macOS + Ubuntu VMs | all | S |
| OSS-8.12 | Launch post | One post (HN / blog) leading with the recording; link to `awesome-ai-agent-governance` PR | Published | 8.7 | S |


---

## M9 — Recovery and pre-flight (≈ 1.5 weeks) — vision 2.61–2.64

**Milestone demo:** an agent wrecks an uncommitted working tree; `memnox rewind` puts it
back in one command and the wreckage is still reachable. `memnox check "deploy payments"`
answers before the loop starts rather than interrupting it half an hour in.

| ID | Goal | Deliver | Accept | Depends | Size |
|---|---|---|---|---|---|
| OSS-9.1 | Milestone snapshots | `core/recovery`: tree object of tracked + untracked-not-ignored, written with `commit-tree` under `refs/memnox/milestones/<id>`; never a branch, never the stash | Snapshot of a dirty tree round-trips; `git log` and `git stash list` unchanged | 5.1 | L |
| OSS-9.2 | `memnox rewind` | `--list`, `--to <id>`, default = the last milestone; restores the working tree only | Files added since the milestone are removed, files changed are restored, ignored files untouched | 9.1 | L |
| OSS-9.3 | Rewind is undoable | A rewind takes its own milestone first | `rewind` twice returns to where it started | 9.2 | S |
| OSS-9.4 | Refuse an unsafe rewind | Merge, rebase, bisect or detached mid-operation → refuse and say which | Fixture repos per state | 9.2 | S |
| OSS-9.5 | Milestone on task start | `memnox run` takes one; interceptors take one before the first write-class action of a session | One session, one milestone, not one per command | 9.1, 7.2 | M |
| OSS-9.6 | Retention | Keep the last N per repository; `memnox rewind --forget` | Old refs deleted, never the newest | 9.1 | S |
| OSS-9.7 | `memnox check "<intent>"` | Resolve intent to actions through the one resolver; evaluate against rules, overlays and layers; execute nothing | Same verdicts as the interceptor would give | 3.4, 5.12 | M |
| OSS-9.8 | Evidence on a refusal | The hold prompt lists what produced the verdict: overlay, rule file and line, repository evidence | Every non-allow names at least the rule | 6.4, 4.6 | M |
| OSS-9.9 | Refusal options | `[d]` deny, `[e]` edit the command, `[o]` overrule — recorded with the person and the reason | An overrule is a row in the ledger, never a silent allow | 9.8 | M |
| OSS-9.10 | `memnox trace <id>` | One action: command, rule, exit code, duration, head and tail of stdout/stderr, capped and retention-bound | Off unless the session recorded streams; documented privacy note | 6.5, 7.11 | M |

**Two rules for this milestone.**

**A rewind that cannot be undone is a second way to lose work.** It snapshots before it
restores, it touches the working tree and nothing else, and it refuses outright when the
repository is mid-merge or mid-rebase.

**An overrule is a row, not a mood.** `[o]` exists because a deterministic block that
cannot be beaten gets uninstalled the first time it is wrong. It carries who and why, and
`why` shows it forever after.

### What is deliberately not here

Slack, meeting transcripts and Notion are **cloud** (C6). The runtime can put the *shape*
of the justified refusal on screen — the overlay, the rule, the repository evidence that
is already on disk — and the cloud fills the rows that need an account. Shipping a Slack
reader in the open half would mean a token on every laptop and a demo instead of a
product.


---

## M10 — Leases and the broker (≈ 1.5 weeks) — vision 2.65

**Milestone demo:** Cursor and Claude Code run in one repository. The second one to write
`src/billing` is told who holds it and what they have been doing, waits, and proceeds when
the first session ends. `memnox lock --list` shows both from a third terminal.

### What already exists to build on

| Piece | Where | What it gives you |
|---|---|---|
| Path evaluation at the moment of a write | `interceptors` `ruleOnCommand`, `ShellSeam` | The seam a lease is taken at. No new interception. |
| A hold something else can release | `core/gate/pending.ts` | `[w] wait` is the same shape as an approval waiting on another terminal. |
| An expiring, moment-argument overlay | `core/policy/overlay.ts` | Copy the expiry discipline exactly; do not invent a second one. |
| Sessions and collision detection | `core/ledger/collision.ts`, `memnox collisions` | The after-the-fact half. A lease is the same subject, prevented. |
| The ledger | `interceptors/record.ts` | `[t] take it anyway` is a row, and `why` reads it. |

| ID | Goal | Deliver | Accept | Depends | Size |
|---|---|---|---|---|---|
| OSS-10.1 | Lease type | `core/coordination/lease.ts`: `{id, path, sessionId, agent, takenAt, expiresAt, pid}`; expiry required, moment passed in | Round-trip; `inForce` matches the overlay tests | — | S |
| OSS-10.2 | Lease store | File-backed under `~/.memnox/leases/`, 0600, one file per lease; atomic create so two processes cannot both win | Concurrency test: 5 processes, one winner | 10.1 | L |
| OSS-10.3 | Overlap rule | Prefix containment on normalized absolute paths; `src/billing` covers `src/billing/invoice.ts` and not `src/billing-legacy` | Table tests, including the sibling-prefix trap | 10.1 | M |
| OSS-10.4 | Reads never wait | Only write-class and destructive actions take or wait on a lease | Conformance row per class | 10.3, 5.11 | S |
| OSS-10.5 | Reclaim a dead owner | A lease whose pid is gone is reclaimable rather than waited on | Kill a holder, next writer proceeds | 10.2 | M |
| OSS-10.6 | Take at the seam | The interceptor takes a lease on the paths a command writes, once per session | One session writing ten files takes one lease, not ten | 10.2, 5.1 | M |
| OSS-10.7 | The held prompt | Names the holder, how long, and what it has done — read from the ledger, not guessed | Matches the vision block | 10.6, 6.5 | M |
| OSS-10.8 | Wait, take, refuse | `[w]` bounded wait, `[t]` recorded override, `[d]` refuse; timeout is a refusal naming the holder | Race test: two writers, first wins, second waits then proceeds | 10.7, 9.9 | L |
| OSS-10.9 | `memnox lock` | `--list`, `<path> --for <window>`, `--release <id>`; a third terminal sees both | Manual two-agent run | 10.2 | M |
| OSS-10.10 | Release on session end | Session end releases its leases; `memnox uninstall` leaves none behind | No lease survives its session in the fixture | 10.2, 7.2 | S |

**The rule that keeps this honest.** This is the first thing here that blocks work for a
reason that is not safety. A policy deny is wrong occasionally and the cost is an argument;
a wrong lease is wrong silently and the cost is somebody's afternoon. So: **it locks paths
and never meaning, it never blocks a read, every lease expires, and a wait is always
bounded.** A lease that could hang an agent forever is worse than the collision it prevents.

### The cloud half

One laptop running two agents needs no account and is the common case. Two laptops on one
repository needs the lease somewhere both can see — `CLD-4.7 shared leases`, riding the
same enrolment and heartbeat as C1/C4. That is the part a team pays for; the broker below
it has to be useful before anybody does.

---

# PART B — CLOSED-SOURCE CLOUD

## C0 — Foundation (≈ 2 weeks) — can start once OSS-6.7 freezes the schema

**Milestone demo:** an org can sign in with SSO, create an API key, and POST a signed event batch that lands in Postgres.

| ID | Goal | Deliver | Accept | Depends | Size |
|---|---|---|---|---|---|
| CLD-0.1 | Repo + infra | Private monorepo: `apps/api`, `apps/web`, `packages/db`; Fly/Railway envs `staging`/`prod`; managed Postgres + Redis | Deploy on merge to `main` (staging) | — | M |
| CLD-0.2 | DB schema v1 | Drizzle: `orgs`, `users`, `memberships`, `runtimes`, `agents`, `sessions`, `events`, `policy_versions` | Migrations + seed | 0.1 | M |
| CLD-0.3 | Auth + SSO | Auth.js/WorkOS: Google + GitHub login; org creation; invite by email | Two users in one org | 0.1 | L |
| CLD-0.4 | Tenancy guard | Every query scoped by `org_id`; RLS policies in Postgres as second line | Test: cross-org read fails at both layers | 0.2 | M |
| CLD-0.5 | Runtime enrollment API | `POST /runtimes/enroll` with one-time token → stores runtime public key, owner | Enroll from CLI stub | 0.3 | M |
| CLD-0.6 | Ingest endpoint | `POST /ingest`: verify Ed25519 signature, validate against event schema v1, dedup by id, insert | 1k-event batch < 500 ms; bad signature 401 | 0.5, OSS-6.7 | L |
| CLD-0.7 | Job queue | BullMQ workers: `graph-build`, `enrich`, `analyze` (empty handlers) | Worker health endpoint | 0.1 | S |
| CLD-0.8 | Web shell | Next.js app: login, org switcher, empty "Agents" page, settings | Deployed at staging URL | 0.3 | M |
| CLD-0.9 | Audit of the audit | Append-only `events`; admin actions logged in `admin_events` | Attempted UPDATE on events rejected by trigger | 0.2 | S |

---

## C1 — Enrollment + sync from OSS (≈ 1 week)

**Milestone demo:** `memnox cloud login` → `memnox cloud enroll` → events from a real session appear in the dashboard within 10 s; disconnecting the network does not affect enforcement.

| ID | Goal | Deliver | Accept | Depends | Size |
|---|---|---|---|---|---|
| CLD-1.1 | OSS: `cloud login/enroll/logout` | Device-code flow; store token in `~/.memnox/identity/`; generate keypair | Token never printed | 0.5 | M |
| CLD-1.2 | OSS: outbox + sync client | Batch N events/T seconds; sign; retry with backoff; `sync.filter = ask,deny,conflict` option | Offline for 1 h → all events arrive later, in order | 1.1, OSS-6.2 | M |
| CLD-1.3 | OSS: sync privacy filter | Strip transcript text, full args; keep digests; drop network payloads (there are none) | Snapshot test of synced payload | 1.2 | S |
| CLD-1.4 | Heartbeat | Runtime sends version, mode, policy hash every 5 min | Dashboard shows "last seen" | 1.2 | S |
| CLD-1.5 | Web: runtime list | Runtimes per org with owner, agent versions, mode | Page live | 1.4, 0.8 | S |

---

## C2 — Agent inventory (≈ 1.5 weeks) — spec §4.1

**Milestone demo:** WOW 8 — one screen showing Claude Code / Cursor / Codex / OpenClaw across the org with session counts, capabilities, and an "unregistered" badge.

| ID | Goal | Deliver | Accept | Depends | Size |
|---|---|---|---|---|---|
| CLD-2.1 | Agent dedup | Fingerprint `{name, major.minor}` across runtimes → `agents` rows | Same agent on 3 laptops = 1 row | 1.2 | M |
| CLD-2.2 | Capability rollup | Union of `capabilities_observed` per agent; counts of read/write/destructive | Matches OSS scan numbers | 2.1 | M |
| CLD-2.3 | Registered agents policy | Org setting: approved agent list; unlisted → `unregistered` flag + notification | Flag appears on new agent | 2.1 | S |
| CLD-2.4 | Web: inventory page | Table + drill-down (sessions, capabilities, owners) | Spec §4.1 view | 2.2 | M |
| CLD-2.5 | Web: agent comparison | Side-by-side counts + risk band from the same OSS rule table (shared `core`) | No numeric score anywhere | 2.2 | S |
| CLD-2.6 | Notifications v1 | Email + Slack webhook for `unregistered agent`, `credential exposure`, `conflict` | Sent once per event | 2.3 | M |

---

## C3 — Central policies (≈ 1.5 weeks) — spec §4.6, flow §7.7

**Milestone demo:** a rule set in the dashboard reaches a laptop on next heartbeat and `memnox why` shows `layer: org`.

| ID | Goal | Deliver | Accept | Depends | Size |
|---|---|---|---|---|---|
| CLD-3.1 | Policy tables | `policies`, `policy_versions` (content, hash, author, approved_by), `policy_assignments` (org / team / runtime) | Migrations | 0.2 | S |
| CLD-3.2 | Policy editor | Web TOML editor with the OSS parser (shared) for validation; `locked` domains toggle | Invalid policy cannot be saved | 3.1, OSS-3.1 | M |
| CLD-3.3 | Approval workflow for policies | Draft → review → active; two-person rule optional | State machine tests | 3.2 | S |
| CLD-3.4 | Distribution | `GET /runtimes/:id/policy` on heartbeat; ETag; runtime stores hash in `policy_versions` | Change → applied within one heartbeat | 3.3, 1.4 | M |
| CLD-3.5 | OSS: org layer in engine | Load org policy as top layer; honor `locked`; offline keeps last | Test: project can't loosen locked rule | 3.4, OSS-3.5 | S |
| CLD-3.6 | Native translation at scale | Org can push "apply native" for Claude Code/Cursor with backup on each runtime | Revert works fleet-wide | 3.4, OSS-3.12 | M |
| CLD-3.7 | Web: policy coverage | Which runtimes are on which version; drift list | Page live | 3.4 | S |

---

## C4 — Routed approvals (≈ 1.5 weeks) — spec §3.6, flow §7.3

**Milestone demo:** a developer's agent hits ASK; a platform lead approves from Slack; the action releases on the developer's machine.

| ID | Goal | Deliver | Accept | Depends | Size |
|---|---|---|---|---|---|
| CLD-4.1 | Approval routing rules | Policy `ask` entries may name `route = ["team:platform", "user:sarah"]` | Parser + validation | 3.1 | S |
| CLD-4.2 | Pending approvals API | Runtime posts `approval.requested`; cloud stores; `GET /approvals/pending` | Timeout mirrored from runtime | 1.2 | M |
| CLD-4.3 | Slack app | Interactive message with Approve / Deny; identity mapped to org user | Button → resolution in < 2 s | 4.2 | L |
| CLD-4.4 | Web: approvals inbox | List, detail (event, evidence), approve/deny | Page live | 4.2 | M |
| CLD-4.5 | OSS: remote resolution | Runtime long-polls / receives push; first resolution wins; local prompt shows "waiting for platform" | Race test local vs remote | 4.2, OSS-4.6 | M |
| CLD-4.6 | `authorized_by` enrichment | Set on the event from the approval | Visible in `why` and timeline | 4.5 | S |
| CLD-4.7 | Shared leases | Runtime posts `lease.taken` / `lease.released`; cloud holds the table; a second laptop sees the first one's lease before it writes | Two runtimes, one repository: the second waits | 4.2, OSS-10.2 | L |

---

## C5 — Graph, `who`, effective capability (≈ 2 weeks) — spec §4.2–4.3

**Milestone demo:** `memnox who --resource production` lists agents with the credential path; a chain `Claude → AWS MCP → creds → Lambda → prod DB` renders as `EFFECTIVE: WRITE → Production DB`.

| ID | Goal | Deliver | Accept | Depends | Size |
|---|---|---|---|---|---|
| CLD-5.1 | Graph tables | `resources`, `edges` (kind, first/last seen, evidence_event_ids[]), `effective_paths` | Migrations | 0.2 | S |
| CLD-5.2 | Resource normalizer | Map repo URLs, MCP server names, credential names, cloud roles, hosts to canonical resource ids | 30 fixture inputs | 5.1 | M |
| CLD-5.3 | Graph builder job | From events + inventories → idempotent edge upserts with evidence | Re-run produces identical graph | 5.2, 0.7 | L |
| CLD-5.4 | Resource tags | Org marks resources `production`, `customer-data`, etc.; suggestions from names (`prod`, `customers`) require confirmation | Tag UI | 5.1 | S |
| CLD-5.5 | Effective-path walker | Traverse credential → role → service → data store edges (from declared infra mappings + observed calls); materialize | Fixture chain from spec resolves | 5.3 | L |
| CLD-5.6 | `who` API + CLI | `GET /who?resource=…`; OSS `memnox who --resource` and question form | Output per spec §4.2 | 5.5, OSS-2.3 | M |
| CLD-5.7 | Web: graph view | Agent → server → credential → resource, filter by tag | Renders 500 nodes usably | 5.3 | L |
| CLD-5.8 | Combined-capability rules (later-stage) | Rule file: e.g. `read:customer-data + write:filesystem + communication ⇒ flag "data export"`; evaluated over per-agent capability sets | 3 seed rules; flagged agents listed | 5.5 | M |

---

## C6 — Organizational context connectors + overlays (≈ 3 weeks) — spec §3.3, flow §7.8

**Milestone demo:** an incident opens in PagerDuty; within a minute, deploys of the affected service on every laptop move ALLOW → ASK with reason `Deployment freeze active — INC-421 (Slack #incident)`.

| ID | Goal | Deliver | Accept | Depends | Size |
|---|---|---|---|---|---|
| CLD-6.1 | Connector framework | `context_sources` table, OAuth storage (encrypted), poll/webhook scheduler, per-connector normalizer interface | Framework test with a fake connector | 0.7 | L |
| CLD-6.2 | GitHub App | Read repos, branch protection, CODEOWNERS, PR reviews, deployments; webhook for changes | Evidence rows for a PR | 6.1 | L |
| CLD-6.3 | Slack app (read) | Channels the org selects; message ingest with author, ts, permalink; retention setting | Evidence rows from a channel | 6.1, 4.3 | L |
| CLD-6.4 | Jira + Linear | Issues, status, links | Evidence rows | 6.1 | M |
| CLD-6.5 | Docs (Google Drive / Notion) | Fetch ADRs/runbooks by folder; store text + link | Evidence rows | 6.1 | M |
| CLD-6.6 | Incident connectors | PagerDuty / incident.io / Opsgenie webhooks → `context_signal(incident, service, active)` | Signal opens and closes with incident | 6.1 | M |
| CLD-6.7 | Signal rules | Org rules: `on incident(service) → class:external-state touching service ⇒ ask`; deploy-freeze keyword detection in Slack requires human confirm | Rule tests | 6.6 | M |
| CLD-6.8 | Overlay distribution | Signals pushed to runtimes as short-lived overlays (TTL); OSS engine applies overlay layer | Overlay expires when signal closes | 6.7, 3.4, OSS-3.5 | M |
| CLD-6.9 | Evidence attachment | Enrich job attaches evidence refs (PR, CODEOWNERS, ticket, Slack permalink) to events by resource + time | `why` shows evidence list | 6.2–6.5 | M |
| CLD-6.10 | Documented-vs-configured check | Parse policy docs for approval counts / protected branches; compare with GitHub config → `policy_gaps` | Spec §4.4 row 1 | 6.2, 6.5 | M |

---

## C7 — Decisions, organizational answer, suggestions (≈ 3 weeks) — spec §3.1, §3.2, §3.5

**Milestone demo:** WOW 9 — `memnox explain "can Claude deploy payments right now?"` returns four rows with evidence from GitHub, Jira, Slack; a suggested rule from Slack sits in the review queue and becomes policy only after a click.

| ID | Goal | Deliver | Accept | Depends | Size |
|---|---|---|---|---|---|
| CLD-7.1 | `decisions` + `evidence_refs` tables | Statement, participants, date, reason, related refs, alternatives, outcome, status (draft/confirmed), `stale_signals[]` | Migrations | 0.2 | S |
| CLD-7.2 | Decision extractor (model, off-hot-path) | Job over Slack/Docs: propose decision drafts with source excerpts; never auto-confirm | Precision review on 50 samples | 6.3, 6.5 | L |
| CLD-7.3 | Web: decision review | Confirm / edit / reject drafts; link to ADR | Reviewer flow < 30 s per item | 7.2 | M |
| CLD-7.4 | Organizational answer engine | For a parsed question: resolve agent, resource, capability (graph) + policy + signals + confirmed decisions → four rows + evidence list; **counts of sources**, no confidence label | Deterministic given the same inputs | 5.6, 6.9, 7.1 | L |
| CLD-7.5 | OSS: `explain` org row | CLI calls cloud when enrolled; degrades gracefully offline | Output per spec §2.3 | 7.4 | S |
| CLD-7.6 | Architecture-rule evaluation | Confirmed decisions with a `rule` field (e.g. "no direct DB access in services") compiled to policy overlays by resource/path pattern | Test: agent adds DB import → ASK with ADR evidence | 7.3, 6.8 | M |
| CLD-7.7 | Staleness checker | Newer contradicting evidence (PR touching the subject, later discussion) → `stale_signals`; badge "possibly outdated" | Fixture test | 7.1, 6.2 | M |
| CLD-7.8 | Suggestions | `suggestions` table; extractor proposes rules from repeated intent; review UI → approve creates draft policy_version | Approved suggestion → policy in C3 flow | 7.2, 3.3 | M |
| CLD-7.9 | Why-was-this-allowed enrichment | For ALLOW events on tagged resources, attach the satisfied conditions (PR approved, CODEOWNER, window open) | `why --allowed` complete | 6.9 | S |
| CLD-7.10 | "New engineer" view | Web: resource → decisions → discussions → PRs → alternatives | Page live | 7.3 | M |

---

## C8 — Gap analysis + authority over time (≈ 1.5 weeks) — spec §4.4–4.5

| ID | Goal | Deliver | Accept | Depends | Size |
|---|---|---|---|---|---|
| CLD-8.1 | Observed-behavior gap | Per written policy: share of decisions that followed it; top exception pattern (e.g. Slack approval by platform lead) | Spec §4.4 row 2 | 6.9, 3.1 | M |
| CLD-8.2 | Implicit authorization | For agents performing actions no policy names: list the evidence that permits it (CODEOWNERS, branch rules, prior approvals, Slack) | Spec §4.4 row 3 | 7.9, 5.3 | M |
| CLD-8.3 | `authority_series` job | Monthly external-write capability count per agent + org | Backfills from snapshots | 2.2 | S |
| CLD-8.4 | Web: authority over time | Bar series; ratio as secondary annotation only | Page live | 8.3 | S |
| CLD-8.5 | Unused authority (org) | Fleet-wide granted vs used; `[Propose least-privilege policy]` creates a draft | Draft opens in editor | OSS-7.9, 3.2 | M |
| CLD-8.6 | Web: gaps dashboard | Documented vs configured vs observed, per resource | Page live | 6.10, 8.1, 8.2 | M |

---

## C9 — What-if simulation (≈ 1.5 weeks) — spec §4.7

**Milestone demo:** WOW 10 — "what if I give Codex production access?" returns +capabilities, +external actions, conflicts, approvals required, and the list of past actions whose decision would change.

| ID | Goal | Deliver | Accept | Depends | Size |
|---|---|---|---|---|---|
| CLD-9.1 | Simulation input model | `{agent, grant: capabilities[] | policyDiff, window}` | Validation | 5.5 | S |
| CLD-9.2 | Replay engine | Load historical events for agent → re-run shared OSS engine with hypothetical stack → diff decisions | Pure function; identical output on repeat | 9.1, OSS-3.4 | L |
| CLD-9.3 | Capability delta | Graph-based: new resources reachable, new external-state actions, combined-capability flags | Fixture chain | 9.1, 5.8 | M |
| CLD-9.4 | Conflict + approval count | Policies and signals the grant would trip; approvals it would need | Counts match manual calc on fixture | 9.2 | S |
| CLD-9.5 | `what-if` API + CLI + web | `memnox what-if "…"` (question form via shared grammar) and dashboard panel; output counts + lists, no prose | Spec §4.7 | 9.2–9.4 | M |
| CLD-9.6 | "Apply as draft policy" | One click turns an accepted what-if into a draft policy_version | Draft created | 9.5, 3.3 | S |

---

## C10 — Audit, export, billing (≈ 2 weeks)

| ID | Goal | Deliver | Accept | Depends | Size |
|---|---|---|---|---|---|
| CLD-10.1 | Org timeline + incident view | Cross-agent timeline; `incident_id` scoping; actor-type filter | Spec §4.6 | 6.9 | M |
| CLD-10.2 | Actor normalization | `actor_type` from runtime + CI/service tokens + human dashboard actions | Filter works | 4.6 | S |
| CLD-10.3 | Export | Signed JSONL/CSV bundles per period; audit-field completeness check (WHO…OUTCOME) | Bundle verifies with published key | 10.1 | M |
| CLD-10.4 | Retention + deletion | Per-org retention; org delete wipes all rows + connector tokens | Deletion test | 0.4 | M |
| CLD-10.5 | Billing | Stripe: free (1 user), team (per seat), enterprise (self-hosted ingest later); feature flags | Paywall on 2nd seat | 0.3 | L |
| CLD-10.6 | Admin + support tooling | Impersonation with audit, org lookup, job retry | Internal only | 0.9 | M |
| CLD-10.7 | SAML SSO + SCIM | Via auth provider | Enterprise checkbox | 0.3 | M |

---

## C11 — Cloud go-live (≈ 2 weeks)

| ID | Goal | Deliver | Accept | Depends | Size |
|---|---|---|---|---|---|
| CLD-11.1 | Security review | Threat model, pen-test of ingest/auth/connectors, secrets at rest encrypted, RLS verified | Findings closed or accepted | all | L |
| CLD-11.2 | Data-processing docs | DPA, subprocessors, what leaves the laptop (names only, digests) — one page | Published | 1.3 | S |
| CLD-11.3 | Observability | Metrics, alerts on ingest lag, queue depth, connector failures; on-call runbook | Alert fires in staging drill | 0.7 | M |
| CLD-11.4 | Load test | 100 runtimes × 10 events/s sustained; graph rebuild under load | p95 ingest < 1 s | 0.6 | M |
| CLD-11.5 | Backups + restore drill | Daily Postgres backups; restore to staging documented and rehearsed | Drill passed | 0.1 | S |
| CLD-11.6 | Onboarding flow | Sign up → enroll first runtime → first inventory in < 10 min, no fixtures | Timed with a new user | 1.1, 2.4 | M |
| CLD-11.7 | Status page + support inbox | | Live | — | S |
| CLD-11.8 | Launch | Pricing page, docs, announcement; design partners' feedback closed | Live | all | S |

---

## 12. Sequencing and staffing

**Critical path (OSS):** M0 → M1 → M3 → M4 → M6 → M8. M2, M5, M7 can each be one developer in parallel once their dependencies land.

**Critical path (Cloud):** C0 → C1 → C3 → C6 → C7. C2, C4, C5 hang off C1; C8/C9 hang off C5–C7.

**With one senior + two juniors:** OSS 1.0 in roughly 3 months; cloud C0–C5 in the following 3 months; C6–C11 in the 3 after that. **Solo:** double each block and cut C5.8, C7.10, C10.7 from the first live version.

**Design partners:** recruit 3 teams at M4 (proxy works); they gate C1–C4 priorities and are the source of real evidence for C6/C7 — never fixtures.

**Two rules that override the schedule:**
1. A milestone ships only when its demo works on a real, non-team machine.
2. Any task that puts a model on the enforcement path is rejected in review, whatever the deadline.

---

# PART C — THE WOW FUNCTIONALITIES

Narrower on purpose: only the features whose job is to produce a reaction, plus the
authenticated-CLI and browser surfaces Parts A and B under-covered.

## C.0 The rule for every WOW

A WOW screen ships only if all six hold:

1. **It is their machine.** Real config, real credentials by name, real agents. No fixtures.
2. **It shows a gap.** Something believed against something true. Counts, never scores.
3. **It is one screen.** Fits a terminal without scrolling. Screenshot-able.
4. **It names the next verb.** `memnox protect`, `memnox why` — never a bare warning.
5. **No model produced it.** Discovery, classification and decisions are deterministic.
6. **No secret value appears, anywhere, ever.** Names, counts, structure and fingerprints
   only. This is the one that is not a matter of taste: a screenshot somebody pastes into
   Slack is the failure mode, and it is unrecoverable.

The emotional sequence is fixed: **exposure → interception → explanation → foresight.**

### Four things the spec left open, decided here

**An unknown verb is `unknown`, and unknown is not a denial.** A verb table covers what
somebody wrote down. `aws some-new-service frobnicate` matches nothing, and the honest
class is `unknown` — reported in the scan, never silently treated as safe *or* as
destructive. Blocking every unrecognised subcommand would break the first real week;
allowing it silently would be the lie. It is allowed and it is counted.

**A verb table is a security control, so it is code review, not a data drop.** These
files decide what gets asked about. A pull request that quietly moves `iam delete-*`
from destructive to read is an attack, and "it is only data" is exactly why it would
land. Every table carries a `checksum` the loader verifies against what shipped, and a
changed table is a review that names the classes that moved.

**`--verify` makes network calls with the reader's credentials, so it is off, always
asked for, and never remembered.** `aws sts get-caller-identity` is read-only, but it
is still Memnox using somebody's production token. It has no config key: if you want
it you type it, every time.

**"Prod-looking" is a guess and is printed as one.** A context named `prod-eu-1` is
reported as *named like production*, never as production. The distinction survives all
the way into the rule text, because a person deciding whether to allow a deploy needs
to know whether we matched a name or read a fact.

## C.1 WOW 1 — `npx memnox`

Credentials are the headline, not tool counts. The section that makes it land is **what
those credentials let an agent do**: `~/.aws/credentials` is a file, "can modify infra
in 2 accounts" is the sentence somebody repeats to a colleague.

The closing two lines are the gap: *N capabilities can change something outside this
laptop. M of them are governed.*

| ID | Goal | Accept | Size |
|---|---|---|---|
| OSS-1.16 | Credential-file detector: names and structural detail only | **Built.** 21 credential kinds, structure only; a test asserts no value survives. | M |
| OSS-1.17 | Authenticated-CLI detector: binary × credential source → headline verb | **Built.** Binary × credential → headline verb, from the verb tables. | M |
| OSS-1.18 | `.env` name heuristics (`*_KEY`, `*_SECRET`, `*_TOKEN`, `*_PASSWORD`) → key-like count | **Built.** Counts variables and credential-like names, including `DATABASE_URL`. | S |
| OSS-1.19 | Browser-automation detector: driver present, persistent profile, saved-login count | **Built.** Driver plus persistent profile; the login store is never opened. | M |
| OSS-1.20 | Closing-gap footer computed from inventory × policy | **Built.** Counted by matching rules against actions, never by counting rule files. | S |
| OSS-1.21 | First-run layout, and `--share` with counts only | **Built.** Credentials lead; `--share` carries counts only. | S |

## C.2 WOW 2 — `memnox explain <thing>`

`explain vercel` prints the credential, the projects it is linked to, the verb table,
and the rule that governs it. The verb table shown is the same one enforcement reads,
so what `explain` promises is exactly what `protect` will gate.

| ID | Goal | Size |
|---|---|---|
| OSS-2.8 | `explain <cli>`: credential, projects/contexts, verb table, governing rule | **Built.** Shows the same table enforcement reads. |
| OSS-2.9 | Question grammar accepts CLI verbs (`deploy`, `apply`, `merge`, `publish`) | **Built.** `apply` and `publish` added. |

## C.3 WOW 3 — `memnox protect`

The line that removes the fear is **"the CLIs keep working"**: denying the credential
*file* while allowing the *CLI* is a distinction most developers have never seen drawn,
and it is the whole reason this is adoptable.

| ID | Goal | Size |
|---|---|---|
| OSS-3.13 | Verb tables as data under `packages/core/verbs/<cli>.toml`, checksum-verified | **Built.** 19 tables, compiled in rather than read from a writable path. |
| OSS-3.14 | `protect --from-scan` generates CLI rules from the verb tables | **Built.** `protect --yes` writes a baseline; `--for` writes one CLI. |
| OSS-3.15 | `protect --for <cli or server>` targeted flow | **Built.** Denies the credential file and keeps the CLI working. |

## C.4 The verb tables

One TOML per CLI. `match` is an argv pattern; classes are the existing tool classes plus
`production` and `secrets` as annotations.

Seed set: `aws`, `gcloud`, `az`, `gh`, `kubectl`, `terraform`, `docker`, `vercel`,
`railway`, `fly`, `heroku`, `netlify`, `psql`, `mysql`, `mongosh`, `npm`, `stripe`,
`git`, `playwright`.

Adding a CLI is a data PR **with a review**, per C.0.

## C.5 WOW 4 — Runtime interception

| ID | Goal | Size |
|---|---|---|
| OSS-5.12 | Interceptor resolves binary → verb table → classes, ahead of the generic classifier | **Built.** One resolver in core, shared by every surface. |
| OSS-5.13 | SQL statement sniffing for `-c`/`-e` and heredocs on DB clients | **Built.** Literals and comments scrubbed first; unbounded is its own action. |
| OSS-5.14 | Browser gate: launcher shim, host ask-per-session, navigations recorded where available | **Built.** One ask per host per session. |
| OSS-5.15 | Model-readable DENY format with the alternative from the verb table | **Built.** The alternative comes from the table, never invented at refusal time. |

The DENY an agent receives is written to be read by a model — and therefore is data the
model will act on. It names the policy and one alternative, and it carries no instruction
the agent could be steered by beyond that.

## C.6 WOW 5 — `why` and `timeline`

| ID | Goal | Size |
|---|---|---|
| OSS-6.8 | `why` evidence for git: branch protection read through `gh` when logged in, cached, read-only | **Built.** Read-only `gh api`, cached, and never reports zero for unknown. |
| OSS-6.9 | Timeline renders CLI events with the verb-table note (`preview`, `production`) | **Built.** |

## C.7 WOW 6 — `memnox watch`

| ID | Goal | Size |
|---|---|---|
| OSS-7.13 | Watch credential directories, so a new login is an event | **Built.** A login is an event. |

## C.8 Cloud additions

| ID | Goal | Size |
|---|---|---|
| CLD-2.7 | Roll up CLI and credential reach per agent | M |
| CLD-5.9 | `who` resolves CLI credential paths as graph edges | M |
| CLD-9.7 | `what-if` accepts credential grants, expanded into verbs by the tables | S |

## C.9 The one line

> **Memnox shows you what your AI agents can actually do on your machine — every
> credential, every CLI, every tool — and lets you put the dangerous ones behind ask or
> deny in two minutes.**

---

# PART D — WHAT PEOPLE PAY FOR

Ordered by who signs the invoice, not by what is interesting to build. Each item names
the buyer, the trigger, and what they do today instead — because a feature whose
current workaround is *fine* does not get bought.

## D.0 How this changes the build

Most of these are **cloud** features. That is not a reason for the runtime to ignore
them: every one of them is worthless without a substrate the runtime has to provide,
and shipping the cloud half against a runtime that cannot hold a call, cannot be
frozen, and cannot sign an export would mean rebuilding both.

So the rule for Part D is: **the runtime builds the substrate, and the substrate is
useful on its own machine before any cloud exists.** A freeze that only works when
somebody buys the cloud is a feature nobody can evaluate. A freeze one person can set
on their own laptop is a feature that already works and later gets a fleet.

## D.1 The list

| # | What they pay for | Buyer | What they do today |
|---|---|---|---|
| 1 | Approval routing for production actions | platform lead | grant nothing, or trust the prompt |
| 2 | Freeze enforcement during incidents | on-call lead | hope |
| 3 | One policy across 30 laptops | eng manager | a README nobody follows |
| 4 | Which laptops can reach production | security | a spreadsheet survey |
| 5 | Shadow agents | security | nothing detects it |
| 6 | What did the AI actually do | postmortem owner | stitching four logs together |
| 7 | Audit trail for AI actions | compliance | a policy PDF |
| 8 | Credential exposure alerts | security | invisible |
| 9 | Least-privilege from actual usage | platform | guesswork |
| 10 | Agent collisions on shared repos | eng lead | found in review |
| 11 | Stopping the collision instead of reporting it | eng lead | rerun the agent and hope |

**If only three ship first: 1, 3 and 6** — approvals, shared policy, and the timeline.
Each is something a team lead is already doing badly by hand.

**Deliberately not here:** organizational answers with evidence, decision extraction,
policy-vs-reality gaps, `what-if`. They need months of events and connectors before
they are true, so they are renewal features and not first-invoice features. Building
them early produces a demo, not a sale.

## D.2 What each needs from the runtime

The honest split. "Runtime" means it works on one laptop with no account.

| # | Runtime substrate | Cloud half |
|---|---|---|
| 1 | A hold that something **other than the terminal** can release, and a pending-approval store to release it from | routing to Slack, identity of the approver |
| 2 | An **overlay layer** with an expiry that flips verbs to ask or deny, and `memnox freeze` to set one locally | PagerDuty/incident.io signal, fleet distribution |
| 3 | Layering with locked domains *(built)*, plus **reporting which version is in force** | central authoring, drift view |
| 4 | Credential paths and production-looking names in the inventory *(built)* | rolling it up across laptops |
| 5 | An **approved-agent list**, so an agent absent from it is flagged | org-wide list, notification |
| 6 | The timeline, actor type, and claim-vs-evidence *(built)* | cross-agent, cross-laptop |
| 7 | A **signed, verifiable export** — the compliance line item is unsellable without it | retention, bundles per period |
| 8 | Credential watching and alerts *(built)* | escalation and the weekly digest |
| 9 | Granted-vs-used *(built)*, plus **a draft policy generated from it** | fleet-wide, one click |
| 10 | Collision detection *(built)* — `memnox collisions` | across people, not just sessions |
| 11 | **Leases on paths and the broker that hands them out** (M10) | one lease table across every laptop on the repository |

Six gaps, all in the runtime, all useful alone — **all now built**:

1. **Pending approvals** — a hold another terminal can release. `memnox approvals`, `memnox approve <id>`, `memnox deny <id>`.
2. **Freeze** — an overlay with an expiry. `memnox freeze <service> --for 2h`, `memnox freeze --lift`. The engine already takes state labels and a rule already carries a `state` field; nothing feeds them.
3. **Policy version** — what is in force, by layer and hash.
4. **Approved agents** — a list in config; anything absent is `unregistered`.
5. **Signed export** — Ed25519 over the event bundle, and `memnox verify` to check one.
6. **`memnox collisions`** and **`protect --from-usage`** — the two things already computed and unreachable.

Two more followed from them, and are built:

7. **Approved agents** — `approvedAgents` in the config. Three states, not two: an
   empty list is *undecided*, never "everything is approved", because flagging every
   agent on a machine nobody has configured is noise, and noise is how a real shadow
   agent gets missed.
8. **Policy version** — `doctor --wiring` prints the content hash of the rule set in
   force, which is what makes "four laptops are on v3" answerable without diffing files.

## D.3 The rule that keeps this honest

**A freeze that outlives its incident is worse than no freeze**, because the next one
gets ignored. Every overlay carries an expiry, `stateFactsInForce` takes the moment as
an argument rather than reading a clock, and a verdict records the state version it was
decided against — so a freeze that never propagated is visible rather than silent.

The same rule applies to a signed export: it states the range it covers and what was
excluded. An export that quietly omitted a day would be worse than no export, because
somebody would rely on it.
