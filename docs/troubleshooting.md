# Troubleshooting

Real failure modes, in the order people hit them. Start with:

```bash
memnox status
```

It answers most of what follows in one call: whether the runtime is reachable,
which rules are loaded, whether a credential was found, and what is waiting.

---

## "Cannot reach the Memnox runtime"

```
Cannot reach the Memnox runtime at http://127.0.0.1:7466.

Start it with:  memnox serve
Or point at another one:  --url http://host:port
```

The runtime is a process. If you closed the terminal it was running in, it is
gone. Start it again with `memnox setup` (which reuses your existing policy file
and token) or `memnox serve --policies memnox.policies.yaml`.

**The MCP firewall fails closed** when it cannot reach the runtime, because a
firewall that fails open is not a firewall. It says so in the refusal, and
`MEMNOX_MCP_FAIL_OPEN=true` inverts it if you would rather keep working than keep
governing.

---

## "No agent token"

```
No agent token. Pass --token, export MEMNOX_AGENT_TOKEN, or run "memnox setup" to store one.
```

Credentials resolve in this order — first hit wins:

1. `--token` on the command
2. `MEMNOX_AGENT_TOKEN` in the environment
3. `~/.memnox/config.json`, written by `memnox setup`

If `~/.memnox/config.json` is missing, run `memnox setup` in your project. To
mint one by hand:

```bash
memnox agents register --name local-editor
```

The token is shown **once**. Only its SHA-256 hash is stored.

---

## A rule exists but never matches

Almost always **project scope**. If your policy file starts with:

```yaml
project: acme-checkout
```

then every rule in it applies *only* to requests that name that project. A
request that names no project sees none of them.

```bash
memnox check repository.force_push main
# Decision : ALLOW — no policy matched      ← wrong
```

The CLI and the MCP server resolve the project by walking up to the nearest
`memnox.policies.yaml`, so run them from inside the repository, or say it
explicitly:

```bash
memnox check repository.force_push main --project acme-checkout
```

Other reasons a rule can miss:

- **Every match field must match.** `actions`, `targets`, `environments`,
  `agents`, `models`, `providers`, `windows` — all of them, and an omitted field
  matches everything. One over-narrow field silences the rule.
- **Wildcards are literal.** `payment/*` matches `payment/api/refund.ts`;
  `payment` alone matches only exactly `payment`.
- **The runtime is holding an older rule set.** `memnox reload` re-reads the
  files. Confirm with `memnox status` — the policy version changes when the
  content does.

---

## A decision says ALLOW but shows a `Withheld:` line

```
Decision : ALLOW
Reason   : observed only: Recursive force-delete is withheld for agents.
Withheld : block (this environment is only being monitored)
```

Working as designed. You are in **monitor mode**: verdicts are computed and
recorded but not applied. That is what a first run does deliberately.

```bash
memnox setup --enforce
```

Monitor mode never rewrites the verdict — an audit record claiming it withheld
when it did not would be worse than no record.

---

## A human approved it and the agent is still withheld

Retry the action. The grant is claimed by **fingerprint**, so the agent does not
need to present an approval id.

If it is still withheld, check in this order:

```bash
memnox approvals status <id>
```

- **`Status: approved` but withheld again** — the grant was already spent. Grants
  are single-use: one grant authorizes one action. Approve again.
- **`Granted: 1/2`** — the policy set `minApprovals: 2`. A second, different
  person must approve; one person counts once.
- **`Status: expired`** — the hold lapsed before anyone acted. The agent must
  re-request.
- **Still `require_approval` with a *different* id** — the retry was not the same
  action. The fingerprint is `agent | action | target | environment`; a different
  file or environment is a different request.

**Some things no approval satisfies:**

| Guard | What you see |
|---|---|
| The agent's declared `capabilities` | `capability: action is outside this agent's declared capabilities` |
| A suspended agent | `agent is suspended` |
| Irreversible action from a tainted session | `…is irreversible and the context contains N untrusted source(s) — no approval can unblock it` |

The last one is by design: `project.delete` and `database.drop` from a session
that saw untrusted content are withheld outright, and break-glass is refused with
403 and audited as critical.

---

## Every policy appears twice in `matchedPolicies`

Fixed — upgrade. The same file reached the runtime by two spellings of one path
(relative from `--policies`, absolute from the registry) and both were loaded.
If you are on an older build, pass the file the same way in both places or drop
one source.

---

## `memnox simulate` says nothing would change, but rules clearly match

Fixed — upgrade. Simulation dropped project scope, so every rule from a file with
a `project:` key matched nothing and the tool reported a confident all-clear.
This was a false negative in exactly the case `memnox setup --project` produces.

---

## The `memnox` command runs the wrong program

```bash
which -a memnox
```

More than one package can claim the `memnox` binary name. If the path resolves
somewhere unexpected, the command you are running is not this runtime.

Working from a clone, prefer an explicit path over `npm link`:

```bash
alias memnox="/path/to/memnox-runtime/node_modules/.bin/memnox"
```

Installed MCP entries are unaffected — they are written with **absolute** paths
to the interpreter and the CLI, precisely so a GUI-launched client that inherits
no `PATH` still runs the right binary.

---

## The audit trail disappeared

Check where the runtime was told to write:

```bash
ps -ww -o command -p $(lsof -ti :7466 -sTCP:LISTEN)
```

If `--data-dir` points into `/tmp` or a scratch directory, the audit log,
registered agents, and approvals live on volatile storage and will vanish. The
default is `.memnox/` in the working directory, which is durable.

Restart with an explicit durable path:

```bash
memnox serve --policies memnox.policies.yaml --data-dir .memnox
```

Related: `--audit-retention-days` prunes events past a horizon. `0` (the default)
keeps everything.

---

## The port is already in use

`memnox setup` probes `127.0.0.1:7466` first. If a Memnox runtime is already
there it **joins** it — registering this repository's rule file and asking for a
reload — rather than fighting for the port. That is what makes one runtime serve
several repositories of one project.

If something *else* holds the port:

```bash
lsof -i :7466 -sTCP:LISTEN
memnox setup --port 7467
```

A runtime you joined keeps the enforcement mode it started in. `setup --enforce`
against a joined runtime says so and changes nothing. Either restart it, or set
the mode over the API, which takes effect on the next decision:

```bash
curl -X PUT localhost:7466/v1/enforcement \
  -H "authorization: Bearer $MEMNOX_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"environments":{"production":"enforce"}}'
```

The map is merged, not replaced, so naming one environment leaves the others on
what they had. It is written to `enforcement.json` in the data directory, so a
restart keeps it. `--enforcement` still wins a cold start, which is what stops a
pinned image being talked down remotely.

---

## The agent does not see the Memnox tools

1. **Restart the client.** MCP server config is read at launch.
2. **Check it is registered:**
   ```bash
   grep -A5 '"memnox"' ~/.claude.json      # or ~/.cursor/mcp.json
   ```
   The entry is a `stdio` server whose command ends in `mcp`.
3. **Reinstall:** `memnox mcp install claude-code`
4. **Check a credential exists** — the server needs an agent token to ask the
   runtime anything. `memnox status` reports whether one was found.

The installer writes only its own `memnox` key, so unrelated servers in the same
config stay. It also will not overwrite an existing Memnox entry.

Remember that these tools are how an agent *asks*. An agent that never calls them
is not governed by them — that is what the MCP firewall and the SDK wrappers are
for.

---

## Verifying nothing has been tampered with

```bash
memnox audit verify
# Audit chain intact — 128401 events verified.
# …or: Audit chain BROKEN at event #91 (0f3a…): content-mismatch
```

This is tamper **evidence**, not tamper proofing: it detects edits to a log you
control, and does not stop someone with write access from recomputing a
consistent chain. On Postgres, two pods appending in the same instant can fork
the chain — verification reports the fork rather than hiding it.

---

## Still stuck

- `memnox <command> --help` for any command
- [ARCHITECTURE.md](../ARCHITECTURE.md) for the fail-open/fail-closed matrix and
  what each stage of the pipeline does
- Open an issue — but **never** a public one for a policy bypass or an
  audit-tampering finding. See [SECURITY.md](../SECURITY.md).
