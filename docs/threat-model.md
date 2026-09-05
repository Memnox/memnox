# Threat model

What this product defends against, what it does not, and where it would fail. Written
before 1.0 so the gaps are stated rather than discovered.

## What is being protected

An agent on somebody's laptop holds their credentials, their filesystem and their
network. The thing worth protecting is **the gap between what it can reach and what
anybody meant it to reach.**

## What Memnox is not

It is not a sandbox, and it is not antivirus. A determined attacker with code
execution on this machine is already past everything here. Memnox governs an agent
doing roughly what it was asked to do, in a way somebody can inspect afterwards.

## Assets

| Asset | Where it lives | Worst case |
|---|---|---|
| Credentials on disk (`~/.ssh`, `~/.aws`, `.env`) | the user's home | read and sent somewhere |
| The event ledger | `~/.memnox/memnox.db` | reveals what was done and when |
| The rules | `memnox.policies.yaml` | edited to permit what it forbade |
| The interceptor directory | `~/.memnox/bin` | replaced, so every command is attacker code |

## What the design already refuses to do

**A secret value never leaves the process that read it.** Discovery stores a path, a
kind and a fingerprint. The ledger stores a digest. `validateEvent` refuses a digest
field holding more than 128 characters, which is the shape of a payload that escaped.

**Nothing is encrypted at rest, and nothing pretends to be.** Files are owner-only
(`0600`) under a `0700` directory. A key this runtime could not honestly promise to
rotate would be worse than none.

**No model is on any enforcement path.** Every verdict comes from a rule table and a
matcher. A model is not consulted, so a prompt cannot talk one around.

**The ledger is append-only in the database, not by convention.** A trigger rejects
any `UPDATE` except recording who released a held call.

## Threats, and where we stand

| Threat | Standing |
|---|---|
| Agent reads a credential it was never meant to | **Covered** by path rules, and by the OS guard where the platform has one |
| Agent exfiltrates a credential in a request body | **Covered** by the egress inspector's credential shapes |
| Agent runs a destructive command | **Covered** by the interceptors and the git hooks |
| Prompt injection makes the agent try something | **Covered** — the rules do not care why it was asked |
| Agent calls the real binary by absolute path | **Not covered by interceptors.** The OS guard and the git hooks are the second line |
| Attacker edits `memnox.policies.yaml` | **Not covered.** Anyone who can write your rules can write your shell profile |
| Attacker replaces `~/.memnox/bin/git` | **Not covered.** Same trust boundary as the rules |
| Another local user reads the ledger | **Covered** by owner-only permissions, and no further |
| Malicious MCP server lies in `tools/list` | **Partly.** Classification is by name and annotation; a tool that lies about its name is classified by the lie |
| A dependency of ours is compromised | **Not covered.** Four runtime dependencies, pinned, with a lockfile |

## Where it would fail

1. **PATH is advisory.** An agent that calls `/usr/bin/git` never meets an interceptor.
   The OS guard, the git hooks and the MCP proxy each close part of this; none closes
   all of it, and no PATH-based tool can.
2. **The rules are a file the agent can write.** If an agent has filesystem write and
   no path rule covering `memnox.policies.yaml`, it can permit itself. `protect`
   proposes a rule for this, and it is not on by default.
3. **Classification by name is a heuristic.** `frobnicate_widget` is `unknown`, and
   unknown is not blocked by default. The overrides file exists for exactly this.
4. **A held call has a timeout.** Nobody at the keyboard for two minutes means denied,
   which is safe, but it also means an unattended run cannot use ASK rules at all.

## Reporting

`SECURITY.md` has the address. Anything that gets a secret value into a report, a
snapshot or the ledger is the highest severity here, whatever else it does.
