# Writing policies

Policies are plain YAML, so they stay reviewable, diffable, and enforced deterministically. All match fields take wildcard patterns (`*` matches anything), and any field you leave out matches everything. When several policies match the same action, the most restrictive effect wins: `block` beats `require_approval`, which beats `allow`.

```yaml
version: 1
policies:
  - name: production-database-protection
    match:
      actions: ["database.delete", "database.drop"]
      environments: ["production"]
    decision:
      effect: withhold
      reason: No AI-initiated destructive database operations in production.

  - name: payment-code-approval
    match:
      actions: ["code.modify"]
      targets: ["payment/*"]
    decision:
      effect: escalate
      approvers: ["security-team"]
```

See [examples/policies/baseline.yaml](../examples/policies/baseline.yaml) for a fuller starting point, and `memnox validate <file>` to check one before you commit it.

## Quorum and time windows

A policy can demand several approvals, and apply only inside a time window:

```yaml
  - name: production-deploy-two-person
    match:
      actions: ["deploy.service"]
      environments: ["production"]
      # Weeknights and weekends only, because business hours are unrestricted.
      windows:
        - { days: [1,2,3,4,5], startHour: 17, endHour: 9 }
        - { days: [0,6], startHour: 0, endHour: 24 }
    decision:
      effect: escalate
      approvers: ["eng-lead", "security"]
      minApprovals: 2
```

Grants accumulate until the quorum is met, one person counts once, and a single denial ends it.

Time windows do not break determinism, because the instant is passed *into* evaluation rather than read from the clock inside the engine. Replaying an audit event with its recorded timestamp reproduces the same verdict.

## Matching on arguments, directory, and branch

A rule can match the call's own arguments, the directory it runs in, and the branch it sits on, so the same tool is routine in one place and refused in another:

```yaml
  - name: no-recursive-delete-in-payments
    match:
      actions: ["shell.execute", "mcp.run_shell"]
      arguments:
        command: ["*rm -rf*"]
      workingDirectories: ["/srv/payments*"]
    decision:
      effect: withhold
      reason: Recursive delete is not an agent action here.

  - name: release-branches-need-a-human
    match:
      actions: ["shell.execute"]
      arguments: { command: ["*git push*--force*"] }
      branches: ["main", "release/*"]
    decision:
      effect: escalate
      approvers: ["eng-lead"]
```

Each named argument narrows the rule further, because every one listed must match. An argument the call does not carry matches only the bare `"*"`.

**Arguments are matched where the call is made, never on the wire.** The raw payload is the one thing a control plane should not collect, so [`@memnox/local-gate`](../packages/local-gate) evaluates it in-process, inside the MCP firewall. The runtime is only told the tool, the target, and the rule ids that matched (`signals`). The SDK strips `arguments` before any request leaves the machine.

## Matching on how big the action is

"Refunds are fine" and "refunds up to a thousand are fine" are different
policies. A rule reads the size the caller reported, in whatever unit the action
counts in: money refunded, rows deleted, seats granted.

```yaml
  - name: large-refunds-need-finance
    match:
      actions: ["payment.refund"]
      aboveAmount: 1000
    decision:
      effect: escalate
      approvers: ["finance-manager"]

  - name: no-refund-this-large
    match:
      actions: ["payment.refund"]
      aboveAmount: 100000
    decision:
      effect: withhold
      reason: A refund this size is not an agent action.
```

Two things are worth knowing about it.

**Above means above.** A rule with `aboveAmount: 1000` does not apply to an
action of exactly a thousand.

**An action that never said how big it was matches.** It cannot prove it is
under the line, and a caller that omits the number must not thereby escape the
rule the number exists for. If you send `amount` sometimes, send it always.

This is also why a size limit belongs here and not only in a control plane.
An authority ceiling routes an action to whoever can authorize it; a rule can
say that nothing authorizes it. Those are different answers and a company needs
both.

## Two more outcomes

```yaml
  - name: candidate-rule
    match: { actions: ["deploy.*"] }
    decision:
      effect: withhold
      mode: observe           # record what it would have done; do not apply it

  - name: deploy-budget
    match: { actions: ["deploy.*"] }
    decision:
      effect: allow
      rateLimit: { max: 10, windowSeconds: 3600 }   # the 11th in an hour is withheld
```

**mode: observe** rolls one rule out without enforcing it. The action proceeds and the audit event records the verdict it withheld, alongside the per-environment `--enforcement` modes.

**rateLimit** is counted by the runtime per agent and per rule, and only an action that actually proceeds spends a slot. It needs a running runtime, because the local gate never counts.

## One project, several repositories

A repository is not the unit of governance, a project is. A frontend and a backend that belong to one product declare the same project, so they share one policy and memory scope:

```yaml
# web/memnox.policies.yaml            # api/memnox.policies.yaml
project: acme-checkout                project: acme-checkout
version: 1                            version: 1
policies:                             policies:
  - name: payment-ui-review             - name: migration-approval
    match:                                match:
      targets: ["src/payment/*"]            targets: ["migrations/*"]
```

```bash
cd web && npx memnox setup --project acme-checkout   # starts the runtime
cd api && npx memnox setup --project acme-checkout   # joins it, adds its rules
```

The identifier is **declared, never inferred**. The CLI and the MCP server both start from the directory they were launched in, walk up to the nearest policy file, and read the project from it. Two repos that say `acme-checkout` resolve to one scope, and anything else stays separate.

One runtime serves every project on the machine. The second `setup` joins the runtime already listening instead of fighting it for the port, registers its rule file in `~/.memnox/policies.json`, and asks for a reload. **Paths travel, rule content never does**, so every rule stays reviewable in the diff of the repo that owns it.

You do not duplicate a rule set across repos. Each one contributes rules about its own surface and they compose under the same most-restrictive-wins semantics, scoped so that one project's rules never decide another's. Rules that must be identical everywhere belong in a shared pack (`memnox policy install production-safety`).

`memnox audit --project acme-checkout` then spans both repositories.

## Policy lifecycle

```bash
memnox ui                              # write rules in a browser instead of YAML
memnox policy packs                    # production-safety, payments, auth-and-secrets, data-privacy, supply-chain
memnox policy install production-safety
memnox policy version                  # content hash of the current rule set
memnox policy simulate -f candidate.yaml --from-audit   # what would change, against real history
```

`simulate` replays your actual audit history through a candidate rule set and reports every decision that would differ. It warns loudly if any action becomes *more* permissive.

Policies stay file-sourced on purpose, because a rule set that is mutable over HTTP is one nobody can review in a diff. `reload` re-reads the file, and authoring belongs to your repository.

## Writing rules without writing YAML

`memnox ui` (or `memnox policy ui`) opens the same rule set in your browser: a form
per rule, the effect as a picker, patterns as chips, live validation as you type, a
preview of the exact YAML it will write, and the simulate panel replaying real history
against what you have edited.

```bash
memnox ui                              # 127.0.0.1 only, opens your browser
memnox ui --file api.policies.yaml --no-open --port 8080
```

It is the same file and the same validator, not a second source of truth — **saving
writes the YAML**, so a rule authored in the browser still lands in the diff a reviewer
reads. Two things follow from that: comments in the file are not carried over when you
save, and a rule with time windows keeps them as written rather than offering a
half-expressive schedule picker.

The server binds loopback and refuses anything else: a request arriving under any other
hostname is rejected, and every API call must carry the session token minted for that
run and embedded in the page, so no other page on your machine can reach it. Nothing
leaves the machine, and it needs no runtime — start one only if you want the simulate
panel to have history to replay.

## Next

- [How a decision is made](how-it-works.md) covers what happens after the rules match.
- [Getting started](getting-started.md) walks through observing, tuning, and enforcing.
