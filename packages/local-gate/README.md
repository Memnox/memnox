# @memnox/local-gate

Policy evaluated **in the process that makes the call**, so a verdict on the
call's own arguments never requires them to travel.

The runtime decides on the tool, the target, and the context. It never receives
the payload. Argument rules run here instead, and what leaves the machine is a
list of rule ids.

```
tool call ──▶ local gate (arguments matched) ──▶ runtime
                    │                              ▲
                    └── blocks here                │
                          {action, target, signals}┘
```

## Using it

```ts
import { LocalGate } from '@memnox/local-gate';

const gate = await LocalGate.fromFiles(['memnox.policies.yaml'], {
  agentName: 'mcp:github',
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
| everything else | the ordinary rule fields — action, target, environment, branch, … |

## What it does not do

**Rate limits.** `decision.rateLimit` is counted by the runtime, which is the
only component that sees every process. A per-process counter is not a limit.

**Replace the runtime.** It runs before it. Both verdicts apply and the
strictest wins, so a local `allow` never overrides a runtime `withhold`.

## Who uses it

- `@memnox/mcp-firewall` — set `MEMNOX_POLICIES` and every `tools/call` is
  matched on its arguments before it reaches the server.
