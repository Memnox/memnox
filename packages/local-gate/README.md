# @memnox/local-gate

Policy evaluated **in the process that makes the call**, so the two things that
must never travel don't: the call's own arguments, and the content it carries.

The runtime decides on the tool, the target, and the context. It never receives
the payload. Argument rules and the secret scanner run here instead, and what
leaves the machine is a list of rule ids.

```
tool call ──▶ local gate (arguments matched, content scanned) ──▶ runtime
                    │                                              ▲
                    └── blocks / masks here                        │
                                          {action, target, signals}┘
```

## Using it

```ts
import { LocalGate, SECRET_RESPONSE } from '@memnox/local-gate';

const gate = await LocalGate.fromFiles(['memnox.policies.yaml'], {
  agentName: 'mcp:github',
  onSecret: SECRET_RESPONSE.BLOCK,
});

const verdict = gate.evaluate({
  action: 'mcp.run_shell',
  target: 'github',
  arguments: { command: 'rm -rf /srv' },
});
// { effect: 'block', reason: '…', signals: ['policy:no-rm-rf'] }
```

`evaluate` is synchronous, deterministic, and does no IO — the same call always
gets the same verdict.

## What it decides

| Input | Decided by |
|---|---|
| `arguments` | `match.arguments` patterns, per named argument |
| argument content | the content shield's secret and PII rules |
| everything else | the ordinary rule fields — action, target, environment, branch, … |

`onSecret` sets what a credential found in an argument does, whatever the rules
said: `block` (default), `redact` (mask it and carry on), or `signal` (report
only). It can only ever tighten a verdict a rule already reached.

Under `redact`, the masked text is re-scanned before it is accepted. If a
finding survives masking, the call is blocked instead — a redaction that does
not actually remove the secret is not an outcome worth having.

## What it does not do

**Rate limits.** `decision.rateLimit` is counted by the runtime, which is the
only component that sees every process. A per-process counter is not a limit.

**Replace the runtime.** It runs before it. Both verdicts apply and the
strictest wins, so a local `allow` never overrides a runtime `block`.

## Who uses it

- `@memnox/mcp-firewall` — set `MEMNOX_POLICIES` and every `tools/call` is
  matched on its arguments before it reaches the server.
- `memnox hook` — the editor hook finds the policy file that governs the
  working directory and evaluates it there.
