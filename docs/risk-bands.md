# Risk bands

A band is not a score. It is the strongest rule that fired, and every rule names the
count that made it fire, so the band can be argued with rather than trusted.

There is no publisher reputation here, no install count and no comparison between
products. This machine cannot see any of those, and a number invented from them would
be exactly the score this product does not ship.

## The rules

Evaluated in order. All of them run; the band is the strongest one that fired.

| Rule | Fires when | Band |
|---|---|---|
| `destructive-tool` | any tool is classified `destructive` | CRITICAL |
| `secret-reachable` | a path above `ordinary` sensitivity is reachable by an agent here | CRITICAL |
| `write-tool-with-credential` | a write tool exists and some server is handed a credential | HIGH |
| `shell-surface` | an agent holds a shell, which reaches everything you can | HIGH |
| `unprobed-server` | a server was never started, so its tools are unknown | MEDIUM |
| `unrestricted-egress` | nothing restricts or observes outbound traffic, and tools exist | MEDIUM |
| `write-tool` | a tool changes external state, with no credential beside it | MEDIUM |
| *(none fired)* | | LOW |

## Why these and not others

**Unprobed is MEDIUM, not LOW.** Zero tools on a server nobody started means unknown,
not harmless. Reporting it as low would be the one lie that matters most, because it is
the case where the reader has the least information and the most confidence.

**Egress only counts when something could use it.** An unrestricted network on a machine
with no tools is a fact about the machine, not a finding about an agent.

**A credential raises a write tool but does not create one.** `write-tool-with-credential`
is HIGH because the pair is what turns a mistake into somebody else's incident. Either
half alone is MEDIUM.

**Nothing here sums.** Three MEDIUM rules do not make a HIGH. A band that could be
inflated by counting would push a reader toward the noisy machine rather than the
dangerous one.
