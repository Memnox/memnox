# Harnesses

Most things that read your code are one agent. Some of them are not.

**Hermes**, **OpenClaw** and **Ruflo** each sit between a person and a runtime. They
route work, define roles, install hooks, spawn background workers, and in two cases
hand work to agents on other machines. On the roster they look like one row. At the
seam they are several.

Memnox says so:

```
AI AGENTS               claude-code, hermes, ruflo
HARNESSES               hermes, ruflo  9 principals
  hermes: 3 roles
  ruflo: 5 roles · runs claude-code, codex-cli · 2 hook files · federated across machines
```

Nine principals behind two rows. That number is read off the disk they scaffolded, not
taken from a count in anybody's README.

## Memnox does not replace what they enforce

This is the part worth being exact about, because the opposite claim is easy to make
and wrong.

| | What it already enforces |
|---|---|
| **Hermes** | Per-server MCP tool filtering (`tools.include` / `tools.exclude`), dangerous-command approval, sandboxing, prompt-injection scanning, cross-session isolation |
| **OpenClaw** | Tool allow/deny lists per agent and per sender, Docker/Podman tool sandbox, workspace access modes, exec approval, operator scopes |
| **Ruflo** | Signed manifests, PII filtering, federation identity and trust levels, CVE remediation, audit trails |

**Each product's filter is read with that product's own rules.** They look alike and
they do not agree: in Hermes a present `tools.include` decides alone and `exclude` is
never consulted, and an explicit `include: []` registers nothing; OpenClaw checks deny
first. Both match tool names case-sensitively, because `readFile` and `readfile` are two
different tools. Reading one product's file with the other's precedence reports the
wrong reachable set, which is the one thing a scan exists to get right.

All three are real controls and Memnox reads them rather than ignoring them. A tool
Hermes excluded is **not** reported as reachable through Hermes; the count it removed is
printed beside the smaller number so it does not read as a scan that missed something:

```
MCP SERVERS             crm, github
                        6 more hidden by the host's own filter, so they are not counted here
```

An OpenClaw agent whose config denies `exec` genuinely has no shell, and the scan does
not give it one.

## What none of them can see

Each of them protects its own runtime. None of them can see:

- **The other two.** Hermes' allow-list has no opinion about what OpenClaw is doing in
  the same repository at the same moment.
- **The disk underneath.** `~/.aws/credentials`, `~/.ssh/id_ed25519`, the `gh` login,
  the browser profile that still holds your sessions. A tool policy governs tools.
- **The shell all three share.** An agent that can run one reaches everything you reach,
  whatever its tool list says.
- **What a set of permitted tools adds up to.** See below.

That is the whole position: *they decide what their agent may call; Memnox decides what
the machine underneath will let through.*

## Combined capability

A tool allow-list checks one call at a time. That is the right thing to check, and it is
not the only thing.

```
COMBINED CAPABILITY  (no single tool does this)

  !  hermes: customer data can leave, in one session
     crm.read_customer → crm.create_customer_export → slack.send_customer_file
```

Every tool in that chain is ordinary. Every one of them passes review on its own.
Holding all three is an exfiltration path, and no per-call filter is shaped to notice it.

Memnox reads chains deterministically, from tool names only:

- an **acquire** step (`read_`, `get_`, `list_`, `query_`, `fetch_`, `download_`, `dump_`)
- an optional **package** step (`export_`, `archive_`, `backup_`, `snapshot_`, `bundle_`)
- an **emit** step (`send_`, `post_`, `publish_`, `share_`, `upload_`, `forward_`, …)

grouped by the **subject** they act on, so `read_customer` plus `send_invoice` is two
jobs and `read_customer` plus `send_customer_report` is one path. A chain is only printed
when no single step is destructive on its own — the destructive ones are already counted
elsewhere, and the whole point of this section is the calls that individually look fine.

Names are all a tool name carries, and the split is on separators and camel humps rather
than substrings: `budget` contains `get`, and a chain built on that would be an invention.
No model is involved, here or anywhere else.

## Where each one is found

Detection is by config file, never by a process list, and every row names the path that
proved it.

| Harness | Read from |
|---|---|
| Hermes | `~/.hermes/config.yaml` (or `config.yml`) — `mcp_servers`, per-server `tools.include` / `tools.exclude`, `enabled`, `agents`, and `approvals.deny` |
| OpenClaw | `~/.openclaw/openclaw.json` — `tools.allow` / `tools.deny`, `agents.entries`; plus `~/.openclaw/agents/`, `sandboxes/`, `credentials/`, `nodes/` |
| Ruflo | Beside the work: `claude-flow.config.json`, `.claude-flow/`, `.swarm/`, `.hive-mind/`; roles from `.agents/` and `.claude/agents/`; hooks from `.claude/settings.json` and `.claude/helpers/hook-handler.cjs`; runtimes from `.claude/`, `.agents/` and `AGENTS.md` |

**Nothing here keys on a directory another product owns.** `.harness/` belongs to
Harness.io's CI and `.ruflo/` is not a thing Ruflo writes; keying on either would have
reported a swarm on repositories running something else entirely. A marker earns its
place by appearing in the product's own documentation, and `.claude/` alone never
counts because Claude Code writes that on its own.

Two rules hold for all three:

**A config that will not parse grants nothing.** OpenClaw writes JSON with comments, so
the reader strips what JSON does not allow and tries again; anything still unreadable is
treated as absence. An unreadable file must never widen what we claim an agent can do.

**A value never leaves the file it was in.** What travels is the *name* of a credential
a config hands a server, never the credential. There is a test that asserts it.

## Governing them

Nothing here is a new enforcement path. They use the ones that already exist.

```sh
memnox explain ruflo           # what it runs, the roles, the hooks, the chain
memnox explain hermes
memnox mcp wrap                # route MCP servers through the proxy
memnox run -- npx ruflo swarm  # PATH, SHELL, proxy vars and a session id for the child
```

`memnox run` is the one that covers all three, because all three ultimately reach the
world through a shell, a binary and a socket.

**Every one of them is wrapped, in its own format.** OpenClaw's `openclaw.json` and a
project's `.mcp.json` are JSON and are written whole. Hermes' YAML and Codex's TOML are
edited a line at a time — only `command` and `args` change, and comments, key order,
quoting style and block lists are copied through untouched, so `memnox mcp unwrap`
returns the file byte for byte as its author left it. A server declared by URL has no
launch line to repoint, so it is named and left alone.

**`protect --apply-native` writes into all three products that publish a permission
format**, so the rules bite even when the agent is not going through the proxy:

| | Written into |
|---|---|
| Claude Code | `~/.claude/settings.json` — `permissions.allow` / `ask` / `deny`, MCP tools included |
| Ruflo | nothing of its own; it scaffolds `.claude/settings.json`, so Claude Code's rules govern it |
| OpenClaw | `~/.openclaw/openclaw.json` — `tools.allow` / `tools.deny` |
| Hermes | `~/.hermes/config.yaml` — `approvals.deny`, which blocks *before* any yolo bypass |

Each refusal to write is deliberate. An `ask` is never written to OpenClaw, which has
two effects where Memnox has three, nor to `approvals.deny`, which is unconditional and
cannot be answered. A tool you already allow that Memnox denies is left in your list and
reported rather than removed, because OpenClaw denies when both name a tool and a revert
could not put back something we deleted. Hermes' YAML is edited a line at a time and the
list we write carries a fence, so a revert takes back exactly ours and a deny list you
maintain by hand is never touched — verified by applying to a real 207-line
`config.yaml` and reverting to a byte-identical file.

The Hermes globs come from the same verb tables the evaluator reads, so `git.push-force`
is written as `git push --force*` and gates exactly what Memnox itself would refuse.

**An MCP rule reaches Claude Code too.** A Memnox action names the tool and not the
server, because the proxy rules on a call before it knows which config launched that
server — so `mcp.delete_customer` compiles to `mcp__*__delete_customer`, which Claude
Code accepts as a deny or an ask. It carries no parentheses, because Claude Code skips
any `mcp__` rule that has them. An *allow* is the exception and is reported rather than
written: Claude Code skips an unanchored allow glob, so an allow has to name its server
(`mcp.crm.read_customer` → `mcp__crm__read_customer`).

**Cursor, Cline, VS Code, Claude Desktop and Codex publish nothing to write.** Codex has
`projects.<path>.trust_level` and Claude Desktop has none at all; a trust flag is not a
translation of a rule, and inventing a format means writing a file the product never
agreed to read. All five are governed at the seams like everything else.

## Skills a harness writes for itself

Hermes writes its own skills between one run and the next, which is the case
`memnox skills` exists for: the dangerous skill is not the obviously wrong one, it is
the one that quietly reaches further than last week's — yesterday it edited files,
today it also runs `kubectl`.

It keeps them a directory deeper than everybody else, grouped under a category:

```
~/.hermes/skills/<group>/<skill>/SKILL.md
~/.claude/skills/<skill>/SKILL.md
~/.agents/skills/<skill>/SKILL.md
```

**Ruflo has no skills directory of its own.** It writes into whichever host it
scaffolded, so its skills are already counted under that host. `.agents/skills` is the
Codex-mode convention and anything may write there, so it is attributed to Codex —
calling it Ruflo would report a swarm on a machine that has none.

OpenClaw is absent from that list. Nothing it publishes says where it keeps them, and a
layout nobody has published is not guessed at.

## Drift

A harness gains a role without any config a client reads changing, so nothing on the
ordinary drift list would ever fire for it. `memnox diff` and `memnox watch` compare the
membership itself:

```
⚠  ruflo now runs more than it did: 1 new role: deployer
   memnox explain ruflo
```

Roles, hook files, the runtimes it drives and federation being switched on are all
compared. A role that went away is reported as a narrowing and never trips
`--fail-on`.

## Federation

Ruflo and OpenClaw can both hand work to agents on other machines. When that is switched
on, the scan says so and says what it cannot do about it:

```
One of these works with agents on other machines; this scan sees only here.
```

The far side is somebody else's laptop. A local scan that implied otherwise would be
worse than one that admits the edge of what it knows.

## In `--json`

`memnox scan --json` emits the capability inventory, version **2**, which added two
arrays:

- `harnesses[]` — `agentId`, `kind`, `runtimes`, `roles`, `hooks`, `federated`, `evidence`
- `chains[]` — `agentId`, `subject`, `consequence`, `steps[{link, server, tool}]`,
  `individuallyHarmless`

Version 1 could not express either without lying about the count: a harness is one agent
row and several principals.
