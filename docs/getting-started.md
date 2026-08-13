# Getting started

From nothing to a governed agent, then to one that actually blocks. Every
command and every output below is real.

> **New to Memnox?** [concepts.md](concepts.md) explains the mental model and
> every term used below — agent, action, runtime, MCP, taint — in about
> five minutes. This page assumes them.

```
setup ──▶ restart agent ──▶ observe ──▶ tune ──▶ enforce ──▶ approve as needed
 10s          once         a day     minutes    1 command      daily
```

---

## 0. Install

```bash
npx memnox setup
```

Or install it once: `npm install -g memnox`.

> If `memnox` runs something other than this CLI, a package claiming the same
> binary name is shadowing it — most often one installed into a `node_modules`
> above your working directory. `npx memnox@latest` pins past it; see
> [troubleshooting](troubleshooting.md#the-memnox-command-runs-the-wrong-program).

Node 20+. No account, no API key, no signup.

---

## 1. Set up a project

```bash
cd ~/your-project
memnox setup
```

```
Wrote starter policies to memnox.policies.yaml (project: acme-checkout)
Detected: payments, database migrations, CI/CD
Packs: production-safety, terminal-safety, payments, data-privacy
Registered agent "local-editor" — token saved to ~/.memnox/config.json
Registered the Memnox MCP server with claude-code

Memnox runtime listening on http://127.0.0.1:7466
Running in the background: pid 4821
Logs: ~/.memnox/runtime.log
Observing only — decisions are recorded, nothing is blocked yet.

→ Stop it:             memnox stop
```

The prompt comes back — the runtime keeps serving in the background, so
`memnox status` and `memnox audit` work in the same terminal. `memnox serve`
still runs in the foreground and is stopped with Ctrl+C; only `setup` detaches.

Open <http://127.0.0.1:7466> for the same numbers as a page: mode, rule count,
what is waiting, and the last decisions.

Four things happened:

| What | Where it landed | Why there |
|---|---|---|
| Rules scaffolded from your stack | `memnox.policies.yaml` | committed, reviewable in a diff |
| A machine-local agent identity | `~/.memnox/config.json` (mode `0600`) | a GUI client inherits no shell environment |
| The runtime | `127.0.0.1:7466`, data in `./.memnox/` | zero infrastructure |
| The MCP server, registered | `~/.claude.json`, `~/.cursor/mcp.json` | so the agent can *ask* before it acts |

Every deterministic guard is on:

```
Guards: shell indirection, taint, decision memory, behavior, trust, verification
```

A **guard** is an extra check that can *tighten* a decision your policies already
made — never loosen it. If a guard cannot answer, it stays quiet rather than
guessing. Here is what each one watches for:

| Guard | Escalates when… |
|---|---|
| **shell indirection** | a destructive command is wrapped to avoid matching — `bash -c`, `eval`, a script that hides the real command |
| **taint** | the agent has read untrusted content this session (a stranger's GitHub issue, a fetched page) and is now doing something privileged. The prompt-injection defense |
| **decision memory** | the action contradicts a decision your team recorded with `memnox memory add` |
| **behavior** | the pattern looks off — a destructive action this agent has never taken, or a sudden burst |
| **trust** | a low-scoring agent attempts something risky. Each block costs 2 points of 100; 50 clean actions earn 1 back |
| **verification** | earlier allowed actions never reported back whether they actually worked |

New terms here — taint, trust score, guard — are defined in
[concepts.md](concepts.md).

That is safe precisely because the first run **observes**. A guard that fires is
a line in the audit trail, not a refused action, so you can read what it caught
before deciding to enforce. `memnox serve` keeps its explicit-flag contract — a
server deployment does not silently gain guards because a local default moved.

Stack detection is deterministic and offline — dependency names and file
existence, no model and no network. The same repository always scaffolds the
same rules, and it only ever *adds* packs.

**Restart your agent.** That is the whole install.

**Less commitment, if you want it:**

```bash
memnox setup --no-mcp      # runtime + policies, your MCP config untouched
memnox setup --no-serve    # scaffold only, bind no port
memnox setup --no-detect   # generic starter rules instead of detection
```

Add `.memnox/` to your `.gitignore`. Commit `memnox.policies.yaml`.

---

## 2. Observe — do not skip this

Nothing is blocked yet, deliberately. A rule you have not read must not wedge
your agent on minute one.

```bash
memnox status
```

```
Runtime   : http://127.0.0.1:7466
Policies  : 10 (version e852ac2d63d0)
Project   : acme-checkout
Credential: stored (config)
Decisions : 214 recent
Waiting   : 1 approval(s)
Observed  : 9 would have been stopped if enforcing
```

**`Observed` is the number that decides whether enforcing is safe.** Look at what
it counted:

```bash
memnox audit
```

```
2026-08-06T05:16Z  ALLOW  local-editor: shell.execute rm -rf ./build
                          Withheld: block (this environment is only being monitored)
```

`Withheld:` is what *would* have been stopped. Run for a day, read them, and you
know whether your rules are right before they can stop anyone working.

---

## 3. Tune

```
edit memnox.policies.yaml
        │
        ▼
memnox validate ─── errors? ──▶ back to edit
        │ ok
        ▼
memnox simulate candidate.yaml
        │
        ├── "MORE permissive" warning ──▶ back to edit
        ▼ all STRICTER
memnox reload ──▶ memnox audit ──▶ back to edit
```

```bash
memnox policy packs                       # prebuilt bundles
memnox policy install production-safety   # append one
memnox validate memnox.policies.yaml      # every error at once, not just the first
```

Then the step that makes a rule change safe to ship — it replays your **real**
audit history through the candidate rules:

```bash
memnox simulate candidate.yaml
```

```
Cases evaluated : 19    Unchanged : 13    Changed : 6

  STRICTER  allow → block             file.write .env.local              [secret-file-protection]
  STRICTER  allow → require_approval  file.write app/(auth)/login/…      [auth-code-review]
  STRICTER  allow → require_approval  dependency.add left-pad@1.0.0      [dependency-addition-approval]
```

And when a change would loosen something:

```
Warning: 1 action(s) become MORE permissive under the candidate set.
  LOOSER  require_approval → allow  shell.execute chmod -R 777 /etc
```

That warning is the guardrail. Treat it as a stop sign.

```bash
memnox reload      # apply without restarting
```

### Writing a rule

```yaml
project: acme-checkout
version: 1
policies:
  - name: payment-code-approval
    match:
      actions: ["code.modify", "file.write"]
      targets: ["*payment*", "*billing*"]
    decision:
      effect: require_approval
      reason: Payment logic changes need security review.
      approvers: ["security-team"]
```

All match fields take wildcards; omitted fields match everything. When several
policies match, **the most restrictive wins** (`block` > `require_approval` >
`allow`). A `minApprovals: 2` gives you the two-person rule.

> **If you set `project:`**, every request must name that project or the rule is
> invisible. The CLI and the MCP server do this for you by reading the nearest
> policy file. See [troubleshooting](troubleshooting.md#a-rule-exists-but-never-matches).

---

## 4. Enforce

```bash
memnox setup --enforce
```

Same rules, now applied. Everything you saw as `Withheld:` becomes real.

---

## 5. The daily loop

This is the only part that repeats.

```
Agent                    Memnox                   You
  │                        │                       │
  ├─ file.write payment/ ─▶│                       │
  │◀─ REQUIRE_APPROVAL ────┤                       │
  │  (agent stops, says why)                       │
  │                        │◀── memnox approve ────┤
  ├─ retries the action ──▶│                       │
  │◀────── ALLOW ──────────┤                       │
```

```bash
memnox approvals            # what is waiting
memnox approve <id>         # grant it — --by defaults to $USER
memnox deny <id>
memnox approvals status <id>
```

The agent then simply **retries the same action** — it does not need to present
the approval id. Two things to know:

- **A grant is single-use.** Approving "write this file" authorizes that write,
  not every write of it until the TTL runs out.
- **A grant is bound to the exact action** — `agent | action | target |
  environment`. It will not carry to a different file, and it does not override
  an agent's capabilities, a suspension, or a non-overridable block.

**Blocked and it should not be?** Fix the rule and `memnox reload`. Do not use
`memnox approvals override` — break-glass requires a reason and is permanently
audited as critical.

---

## 6. Ask before acting

The cheapest governance is the kind an agent gets *before* it commits to
something.

```bash
memnox context file.write 'src/app/(auth)/login/page.tsx'
```

```
Memnox constraints for "file.write src/app/(auth)/login/page.tsx"
This action would need human approval before it proceeds (risk: medium).
Next: ask security-team to approve before this proceeds.

Rules that apply — these decide whether this proceeds:
  - auth-code-review — your policy, requires approval
      Auth and session code changes need a second pair of eyes.
      approvers: security-team

None of this is a judgement on the work itself — the rules above are your
organization’s, quoted as declared.
```

Every line of that is a **constraint** your organization declared — a policy you
wrote, or a signal a deterministic advisor raised — quoted verbatim. Nothing is
generated, and when no rule matches it says so rather than implying approval.

Asking records nothing and raises no approval.

### The agent asks on its own

`memnox setup` already registered the MCP server, so after a restart your client
has two tools: `memnox_check_rules` (the briefing) and `memnox_status`.

```bash
memnox mcp install              # if you used --no-mcp, or added a client later
memnox mcp uninstall claude-code
```

---

## 7. Beyond one client

```bash
# any other MCP client — Windsurf, Zed, Codex
memnox-mcp-firewall --name github -- npx -y @modelcontextprotocol/server-github

# a script or a pipeline step: one decision, printed with the rules behind it
memnox check deploy.service checkout-api --env production

# evidence
memnox replay <sessionId>    # one agent session, in order
memnox report                # compliance markdown/JSON
memnox audit verify          # "Audit chain intact — 128401 events verified."
```

Your own agent loops, same signatures:

```ts
import { MemnoxClient, governTools } from '@memnox/sdk';

const tools = governTools(memnox, { readFile, writeFile, runShell }, { sessionId: runId });
```

**Team scale** is four flags on the same binary — nothing about the solo path
changes:

```bash
memnox serve --database-url postgres://… --redis-url redis://… \
             --audit-retention-days 365 --rate-limit 600
```

---

## What it left on your machine

```
your-project/
  memnox.policies.yaml     ← commit this. it is the whole config.
  .memnox/                 ← gitignore this. audit log, agents, approvals.

~/.memnox/config.json      ← agent token, mode 0600
~/.memnox/policies.json    ← rule-file registry for multi-repo projects
~/.memnox/runtime.pid      ← what "memnox stop" signals
~/.memnox/runtime.log      ← what the background runtime printed
~/.claude.json             ← one MCP server entry
~/.cursor/mcp.json         ← the same entry, for Cursor
```

**Backing out** is `memnox stop`, then `memnox mcp uninstall <client>`. Nothing
phones home; there is nothing to cancel.

---

## The one mistake to avoid

**Do not run `--enforce` on day one.** A week of `Withheld:` lines costs nothing
and tells you exactly which rules are wrong. Enforcing before you have read them
is how a governance tool becomes the thing everyone disables.
