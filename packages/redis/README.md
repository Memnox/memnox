# @memnox/redis

Redis adapters for the `LockService` and session-taint ports — shared coordination
for multi-instance deployments.

```bash
memnox serve --redis-url redis://localhost:6379
# or MEMNOX_REDIS_URL
```

Without it, locks and rate limits are per-process: three replicas enforce three
separate limits, and a scheduled sweep runs three times.

## What it implements

| Port | Adapter |
|---|---|
| `LockService` (`@memnox/core`) | `RedisLockService` |
| session taint storage (`@memnox/core`) | `RedisSessionTaintStore` |

## Deliberate fail asymmetry

`RedisLockService` fails **differently** depending on what is being asked, and
this is the important thing to understand before changing it:

- **Acquiring a lock fails closed.** If Redis is unreachable, the lock is not
  granted and the work does not run. Two instances running the same sweep is
  worse than neither running it.
- **Cooldown checks fail open.** If Redis is unreachable, the action proceeds. A
  cooldown is a politeness mechanism; refusing all work because a cache is down
  turns a degraded dependency into an outage.

The asymmetry is inherited from the predecessor codebase, where collapsing both
to one behaviour caused an incident in each direction.

## Atomic increments

Rate limiting uses a Lua script so check-and-increment is a single round trip.
A read-then-write pair lets two instances both see "under the limit" and both
proceed.

## Connection state

The service tracks readiness and logs transitions once, not per call — a Redis
outage should produce one log line and a changed behaviour, not a flood.

Connection failures never throw into the caller. The `LockService` contract is
that its methods answer; how they answer under failure is the asymmetry above.
