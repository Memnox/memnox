# Learning from behaviour

Discovery answers what your agents *can* reach. After a day of real work, the record
answers something better: **what they actually did, and what they never needed.**

Least privilege written from behaviour rather than from imagination is the strongest
thing you can do with a day of history.

```bash
memnox learn
```

```
claude-code  (agt_1abb3308)

  You granted this agent 14 action(s) and it used 27% of them.

  From 7 day(s), 31 session(s), covering 96% of its traffic.

  used
    filesystem.read
    repository.read
  used, still ask
    shell.execute
  never touched
    cloud.write
    database.delete
  tried and refused
    filesystem.read .env  4×
    Repeatedly refused means a rule is wrong, or no alternative was named.
```

## The three lists, and why they are three

**Used** is what actually proceeded. A withheld attempt proves the agent wanted the
reach, not that it needed it, so counting it would defeat the point.

**Never touched** is the complement: what was reachable, minus what was used, over a
stated window. This is where a rule proposing to deny comes from.

**Tried and refused** is neither. An action a rule already refuses needs no second rule
proposing to refuse it, and listing it as "never used" would be misleading — it was
tried, repeatedly. Denials are as informative as approvals: an agent repeatedly refused
something is either misconfigured, or it was never told what to use instead.

## Sample size travels with the answer

Four days of one developer's work is not a policy for a team. The window, the sessions
and the coverage ride on the proposal itself, in a comment at the top of the file it
writes:

```yaml
# Proposed from 7 day(s), 31 session(s),
# 14 distinct action(s), covering 96% of this agent's traffic.
# Read it, edit it, then apply it. It is a proposal, not a policy.
version: 1
policies:
  - name: agt_1abb3308-observed-allow
    match:
      agents: ["agt_1abb3308"]
      actions: ["filesystem.read", "repository.read"]
    decision:
      effect: allow
      reason: "Observed in the window above."
```

A proposal that hid how little it saw would be a trap.

## The file is the format a person writes

```bash
memnox learn --out memnox.proposed.yaml
memnox validate memnox.proposed.yaml
memnox simulate memnox.proposed.yaml
```

It is ordinary policy YAML: readable, editable, committable, diffable. A generated
policy in a private format is a black box nobody adopts, so there is not one.

Nothing is applied. `learn` proposes; you read it, edit it, and commit it like any other
rule.

## What the record keeps

Every verdict is on disk and chained, so a local record is still evidence. Beside it, a
flight recorder keeps frames: the intent a session declared, the context it read and the
trust of each block, and the verdict itself.

**Arguments are hashed and results summarised.** A ledger that stored what an agent read
would become the single most valuable file on the laptop, and the product would be the
vulnerability. Frames carry a `payloadDigest`, never a payload.

Full fidelity on anything withheld or escalated; the allowed majority is sampled, which
is where the bytes are. Sampling is deterministic off the decision id, so replaying the
same day keeps the same frames.

## Next

- [Operating](operating.md) — how much of this is actually governed, and how to stop an agent.
- [Policies](policies.md) — turning a proposal into rules in force.
