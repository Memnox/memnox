# Memnox — Build Plan: Milestones and Developer Tasks

**From empty repo to live product**

> Section numbers like *spec §2.4* point at the functional spec, which is not in this
> repository. Stack choices are **[proposed]**.

**What this plan is built toward.** `VISION.md` is the vision all three repositories share,
written as a strategy note rather than as an architecture, over one move: do not sell protection,
sell **the ability to safely increase agent autonomy**. The category it names is a **control
plane for autonomous work**. Part I is the always-on case in twenty sections, Part II the local
wedge in ten. Cite a section as `I.NN` or `II.NN` when a milestone is answering to one: `I.8` two
agents on one file, `I.9` agent rollback, `II.2` effective capability, `II.9` cross-agent
protection.

**The sixty-five pains and the `§01` to `§12` phase index went with the previous vision.** A
`2.NN` or `§NN` citation left in this plan, in a source comment or in a test resolves to nothing
now, and should be rewritten to the section it actually answers the next time that line is
touched. `spec §2.4` is unaffected: that is the functional spec, a different document, and it is
still not in this repository.

**This copy is the original.** `memnox-cloud/VISION.md` and `memnox-client/VISION.md` are verbatim
copies of it, because all three repositories are version controlled and the directory above them is
not. Copy it across whole when it changes, so a diff between the three stays empty.

---

## 0. How to read this plan

### 0.1 Task format

Every task is sized for one junior developer with a reviewer, **0.5–3 days**, and has:

```text
ID        OSS-1.3
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
- Nothing writes outside `~/.memnox/` or `<project>/.memnox/` unless the task says so and a backup is taken.
- No LLM call on any enforcement path. Ever.

### 0.3 Proposed stack **[proposed]**

| Layer | Choice | Why |
|---|---|---|
| CLI/daemon | TypeScript, Node ≥ 20, pnpm workspace, `commander`, `better-sqlite3`, `@modelcontextprotocol/sdk`, `chokidar`, `vitest` | Already on npm; single-binary via `pkg`/`bun build` later |
| Repo layout | `packages/core` (engine, store), `packages/cli`, `packages/proxy`, `packages/interceptors` | One domain package the other three speak |

### 0.4 Milestone map

```text
M0  Foundation
M1  scan
M2  explain + diff
M3  protect (policy engine)
M4  MCP proxy
M5  Shell / git / fs / network interception
M6  Event store + why + timeline
M7  watch + sessions + limits + conflicts
M8  Hardening + go-live
M9  Recovery and pre-flight
M10 Leases and the broker
```

Strictly sequential through M8 — each milestone is the demo for the next. M9 and M10 hang off M5–M7 rather than extending the chain: recovery needs the interception seam, and leases need sessions.

### 0.5 Code conventions

Three rules, enforced in review.

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

# THE MILESTONES

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
| OSS-6.7 | Freeze event schema v1 | `docs/event-schema.md` + JSON schema published; version field | Published and versioned; anything reading the ledger can pin to it | 6.2 | S |

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

## M9 — Recovery and pre-flight (≈ 1.5 weeks) — vision `I.9`

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

Slack, meeting transcripts and Notion are not here and are not coming. The runtime can
put the *shape* of a justified refusal on screen — the overlay, the rule, the repository
evidence that is already on disk — from what a laptop can read on its own. Shipping a
Slack reader here would mean a token on every laptop and a demo instead of a product.


---

## M10 — Leases and the broker (≈ 1.5 weeks) — vision `I.8`, `II.9`

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
| OSS-10.7 | The held prompt | Names the holder, how long, and what it has done — read from the ledger, not guessed | Matches the `I.8` block | 10.6, 6.5 | M |
| OSS-10.8 | Wait, take, refuse | `[w]` bounded wait, `[t]` recorded override, `[d]` refuse; timeout is a refusal naming the holder | Race test: two writers, first wins, second waits then proceeds | 10.7, 9.9 | L |
| OSS-10.9 | `memnox lock` | `--list`, `<path> --for <window>`, `--release <id>`; a third terminal sees both | Manual two-agent run | 10.2 | M |
| OSS-10.10 | Release on session end | Session end releases its leases; `memnox uninstall` leaves none behind | No lease survives its session in the fixture | 10.2, 7.2 | S |

**The rule that keeps this honest.** This is the first thing here that blocks work for a
reason that is not safety. A policy deny is wrong occasionally and the cost is an argument;
a wrong lease is wrong silently and the cost is somebody's afternoon. So: **it locks paths
and never meaning, it never blocks a read, every lease expires, and a wait is always
bounded.** A lease that could hang an agent forever is worse than the collision it prevents.

**Built.** `core/coordination` holds the lease, the register, the overlap rule and the
gate; `memnox lock` lists, takes, releases and forgets; the shell seam takes one before a
write and never for a read; `memnox run` releases what a session held even when the agent
crashed. Two things the tests forced and the plan did not say: a write claims the
directory it lands in, because a lease per file is ten refusals for one afternoon, and the
wait is bounded by a count as well as by the clock, because a clock that does not advance
would otherwise be a hang.


## What the vision asked for, and where it is

`VISION.md` is thirty sections. These are the ones with a surface, so the next person
does not go looking for something that is not there.

| Section | Where |
|---|---|
| `I.3` circuit breaker | `core/session/breaker.ts`, held via `core/session/pause.ts`; the daemon counts outcomes on `RECORD`. `memnox paused` / `memnox resume`. Error loop, no progress, action explosion, scope drift and a reported-spend ceiling. The flat ceilings stay in `core/daemon/limits.ts`. |
| `I.4` skill quarantine | `core/discovery/skills.ts`, `memnox skills`. A skill whose reach grew since it was accepted is held. |
| `I.6` progressive autonomy, `I.16` what to automate next, `I.20` the primary screen | `core/session/autonomy.ts`, `memnox next`. |
| `I.7` role-based authority | `policy.match.roles` was already parsed and matched and nothing ever set the field. `memnox run --role`, `MEMNOX_AGENT_ROLE`. |
| `I.8` two agents on one file | `core/coordination`, `memnox lock`. |
| `I.10` black box | `timeline`, `why`, `trace`, and `memnox claims` for what was said against what was recorded. |
| `I.12` grouped approval | `core/gate/grouping.ts`; `memnox approvals` groups by default, `approve --group`. |
| `I.13` autonomy budget | `core/session/budget.ts`, `memnox budget`, enforced in the daemon. |
| `I.15` daily agent CFO | `core/session/operations.ts`, `memnox report`. |
| `I.1`, `I.2`, `I.5`, `I.14` autopilot and blast radius | `core/session/autopilot.ts`, rendered by `cli/next/boundary-report.ts` under `memnox next --agent`. |
| `I.3` scope drift, and the task everything compares against | `core/session/session-task.ts`; `memnox run --task/--paths/--expect`. |

**Three rules these all had to obey, and they are worth keeping.**

**Counts, never scores.** `memnox next` prints how many times somebody said yes, not
how many hours they would save. A number nobody can check does not belong on a screen
somebody is being asked to act on.

**Never estimate what only somebody else can report.** There is no spend line in
`memnox report` and a `usd` budget counts nothing on its own: this machine watches a
command run and cannot price a model call. `EventCost` is the seam for whatever can.

**An unruled capability is not a permitted one.** `memnox next --agent` counts what no
rule covers in its own band and refuses to call a boundary ready while most of the
agent's reach is unruled. Filing those under "runs on its own" would be the screen a
person trusts most telling a comfortable lie.

**What the audit of remote agents found, and what closed it.** Every seam took an
optional `HoldService` and nothing outside a test ever built one, so an `ask` rule
reached `Nobody could be asked, so it was denied`. `ask` was a synonym for `deny`
everywhere, and `PendingApprovals` — the file-backed queue that exists so a second
terminal or the control plane can answer — had readers and no writer. `core/gate/routed-prompt.ts`
is the fix: the question is written down first and answered from the terminal, from
`memnox approve`, or from the workspace, whichever arrives first.

Three things follow from that seam being real. A held call travels up on the heartbeat
and its answer comes back on the next one, which is the only per-machine round trip
there is and so the only way to answer a question raised on a box nobody can reach
(`memnox-cloud/src/machines/held-call.ts`). Leases consult the workspace register the
cloud already had and the runtime had never called. And a budget can be counted across
the fleet, because one counted per machine is one multiplied by however many machines
there are.

All three degrade rather than block: an unreachable control plane turns a fleet budget
into a machine budget and a shared lease into a local one, and leaves a held call still
answerable from a terminal. A lease is coordination and not safety, so one that blocked
work whenever the network hiccuped is one people would turn off inside a day.

**What the surface looked like with forty commands on it, and what closed it.**
`--help` listed forty top level commands, which is a list nobody reads: somebody
who cannot find the four that matter concludes the product is for somebody else.
`program.ts` now holds a `SPINE` of nineteen and `configureHelp` filters the rest
off the front page, where they keep running and keep their own `--help`. The
decision about what a newcomer sees lives in that one list rather than spread
across thirty registration functions where the next one added forgets.

Four commands went rather than moved. `diff` is `scan --since`, because it is the
same scan compared against the kept one and two commands for one question is one
of them going unrun. `autopilot` is `next --agent`, because both answer whether to
hand something over and only the evidence differs: the ledger backwards, or the
rules forwards. `verify --enforcement` is `doctor --prove`, beside the `--wiring`
it is the second half of. `spend` is gone outright, because this machine cannot
price a model call and a command that asks somebody to type the number is the
product pretending otherwise. `unknown-command.ts` names where each went, because
a nearest-word guess sent `diff` to `deny`, which is a different command that runs.

**Agents have a name a person chose, and an id nothing may move.** `agt_claude-code`
is what every ledger row is keyed on; the name in `~/.memnox/agents/names.json` is
what every screen prints, and `resolveAgent` answers to either, to the id without
its prefix, and to the product. `agents discover` asks for one per agent with Enter
keeping the detected name, through an injected asker so a test names five agents
with no terminal. It never asks under `--json` or with nothing on stdin, and a
refused name is said and skipped rather than re-asked: a discovery that could not
be finished by pressing Enter is one people learn to run with a flag.

**A name is only an identity if it travels.** The control plane hashes the
hostname and never stores it, so an agent onboarded through the device flow
reached the fleet listing as a hex id and the name a person had just chosen
lived only on their laptop. `enrol.ts` now sends it as `label`, and the cloud
carries it through `POST device/codes`, the pending-approval screen and
`machines.enrol`, where the field already existed and nothing ever set it from
this direction. `machineLabel` in `machine.ts` is the one normalizer both doors
use, because two of them is one of them drifting.

**Four steps are one intention, so there is one command for them.** `login`,
`agents discover`, `agents name` and `agents onboard` each do a step, and
somebody meeting this product has to know all four exist and what order they go
in. `memnox setup` is the guided run: it connects, scans, and then goes agent
by agent through what that agent can already reach, what the workspace should
call it, and whether to put it under Memnox. Per agent rather than in bulk,
because a list of five names with one prompt under it is a screen people say yes
to without reading, and because the name only means something beside the reach.
It is new wiring and no new machinery: every step calls what already owned it,
and `sync/connect.ts` exists so `login` and this share one device flow rather
than two that drift.

It is `setup` rather than `onboard` because `agents onboard <agent>` already does
the precise version of its last step, and two commands one word apart, one
looping over what the other does once, is a pair nobody can tell apart in a help
listing. OSS-8.1 removed `setup` from the *hero* so that bare `npx memnox` runs
`scan`, and that still holds: `scan` keeps `isDefault`, and the first thing this
product does is show somebody their own machine rather than ask them to sign in.

**What the guided run had to get right, learned from watching a competitor's.**
Three things. It asks per agent rather than listing six and putting one prompt
under them, because the second is a screen people agree to without reading. It
finds out an agent cannot be managed *before* asking about it, because answering
two questions and then being told the third step was never going to work is
worse than not being offered. And it prints a row for every agent it offered,
including the ones nothing happened to: a summary of only the successes is how a
run ends with somebody believing five agents are governed when two are.

The prompt order is name then confirm, and a `y` at the name prompt is read as
an answer to the next question. The reverse order loses a typed name to a yes/no
reader, which silently skips the agent and never names it.

**Half the agents it could find were agents it could not govern.** Onboarding
rewrote JSON only, so Codex (TOML) and Hermes (YAML) were detected, listed and
refused. `agents/managed-toml.ts` and `agents/managed-yaml.ts` close that, each
editing its format the way that format survives being edited: TOML gets a table
appended as text, because a `[header]` closes whatever was open and every
original byte then survives, and YAML goes through `parseDocument` so the
comments come back, because a Hermes config is edited by hand. Re-serializing
TOML through a writer would have handed back a file meaning the same thing and
looking nothing like the one somebody wrote.

**JSON was the format this claimed to support and handled worst.** `JSON.parse`
threw on the first `//`, so a VS Code or Cline config with one comment in it
reported that the agent could not be managed, which is the same gap TOML and YAML
had. And `JSON.stringify(next, null, 2)` rewrote every line: a four-space config
came back two-space, so adding four lines produced a diff touching a hundred and
a reviewer had to read all of it to find the change. `agents/managed-json.ts`
edits by span through `jsonc-parser`, matching the indentation already in the
file. A test asserts that no line the rewrite did not change is different
afterwards, which is the property all three formats now hold.

**The spelling of an HTTP entry in somebody else's config is a guess, so the
rewrite checks itself.** `checked()` parses the result back and refuses it unless
it still holds every server it held plus the managed one. That is what makes
adding a format safe rather than a hope: being wrong costs an entry that does not
authenticate, which `offboard` reverses byte-identically from the backup, and
never a config the agent cannot load. `manageable()` runs the same rewrite as a
dry run before anybody is asked a question, so an unsupported config is found out
at the top of the flow rather than after two answers.

**What rendering the boundary found.** The generated baseline's git rule was described
as "force-pushing, and hard resets" and matched `git.push`, `git.reset`, `git.clean` —
so it denied every ordinary push and permitted `git push --force`, which is the whole
point inverted. `domains.ts` now names what the verb table actually produces, and
`domains.test.ts` asserts every destructive git verb is covered.
---

## Sequencing and staffing

**Critical path:** M0 → M1 → M3 → M4 → M6 → M8. M2, M5, M7 can each be one developer in
parallel once their dependencies land. M9 and M10 hang off M5–M7 rather than extending
the chain.

**With one senior + two juniors:** roughly 3 months to 1.0. **Solo:** double each block.

**Design partners:** recruit 3 teams at M4, when the proxy works. They are the source of
real evidence for everything after it — never fixtures.

**Two rules that override the schedule:**
1. A milestone ships only when its demo works on a real, non-team machine.
2. Any task that puts a model on the enforcement path is rejected in review, whatever the deadline.

---

# THE WOW FUNCTIONALITIES

Narrower on purpose: only the features whose job is to produce a reaction, plus the
authenticated-CLI and browser surfaces the milestones above under-covered.

## W.0 The rule for every WOW

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

## W.1 WOW 1 — `npx memnox`

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

## W.2 WOW 2 — `memnox explain <thing>`

`explain vercel` prints the credential, the projects it is linked to, the verb table,
and the rule that governs it. The verb table shown is the same one enforcement reads,
so what `explain` promises is exactly what `protect` will gate.

| ID | Goal | Size |
|---|---|---|
| OSS-2.8 | `explain <cli>`: credential, projects/contexts, verb table, governing rule | **Built.** Shows the same table enforcement reads. |
| OSS-2.9 | Question grammar accepts CLI verbs (`deploy`, `apply`, `merge`, `publish`) | **Built.** `apply` and `publish` added. |

## W.3 WOW 3 — `memnox protect`

The line that removes the fear is **"the CLIs keep working"**: denying the credential
*file* while allowing the *CLI* is a distinction most developers have never seen drawn,
and it is the whole reason this is adoptable.

| ID | Goal | Size |
|---|---|---|
| OSS-3.13 | Verb tables as data under `packages/core/verbs/<cli>.toml`, checksum-verified | **Built.** 19 tables, compiled in rather than read from a writable path. |
| OSS-3.14 | `protect --from-scan` generates CLI rules from the verb tables | **Built.** `protect --yes` writes a baseline; `--for` writes one CLI. |
| OSS-3.15 | `protect --for <cli or server>` targeted flow | **Built.** Denies the credential file and keeps the CLI working. |

## W.4 The verb tables

One TOML per CLI. `match` is an argv pattern; classes are the existing tool classes plus
`production` and `secrets` as annotations.

Seed set: `aws`, `gcloud`, `az`, `gh`, `kubectl`, `terraform`, `docker`, `vercel`,
`railway`, `fly`, `heroku`, `netlify`, `psql`, `mysql`, `mongosh`, `npm`, `stripe`,
`git`, `playwright`.

Adding a CLI is a data PR **with a review**, per C.0.

## W.5 WOW 4 — Runtime interception

| ID | Goal | Size |
|---|---|---|
| OSS-5.12 | Interceptor resolves binary → verb table → classes, ahead of the generic classifier | **Built.** One resolver in core, shared by every surface. |
| OSS-5.13 | SQL statement sniffing for `-c`/`-e` and heredocs on DB clients | **Built.** Literals and comments scrubbed first; unbounded is its own action. |
| OSS-5.14 | Browser gate: launcher shim, host ask-per-session, navigations recorded where available | **Built.** One ask per host per session. |
| OSS-5.15 | Model-readable DENY format with the alternative from the verb table | **Built.** The alternative comes from the table, never invented at refusal time. |

The DENY an agent receives is written to be read by a model — and therefore is data the
model will act on. It names the policy and one alternative, and it carries no instruction
the agent could be steered by beyond that.

## W.6 WOW 5 — `why` and `timeline`

| ID | Goal | Size |
|---|---|---|
| OSS-6.8 | `why` evidence for git: branch protection read through `gh` when logged in, cached, read-only | **Built.** Read-only `gh api`, cached, and never reports zero for unknown. |
| OSS-6.9 | Timeline renders CLI events with the verb-table note (`preview`, `production`) | **Built.** |

## W.7 WOW 6 — `memnox watch`

| ID | Goal | Size |
|---|---|---|
| OSS-7.13 | Watch credential directories, so a new login is an event | **Built.** A login is an event. |

## W.8 The one line

> **Memnox shows you what your AI agents can actually do on your machine — every
> credential, every CLI, every tool — and lets you put the dangerous ones behind ask or
> deny in two minutes.**
