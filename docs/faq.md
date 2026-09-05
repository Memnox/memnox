# FAQ

### Does it call an LLM?

**No.** Not on any path, at any point. Every verdict comes from a rule table and a
matcher, and the classifiers are fixed word lists you can read. The one place a model
could plausibly help — reading a question like "can claude deploy payments" — is a
hand-written grammar instead, and it refuses phrasings it does not know rather than
guessing at them.

### Does anything leave my machine?

No. There is no account, no telemetry by default, and no network call on any path.
`memnox scan` starts MCP servers to ask what they hold, which is local. The network
probe reads environment variables and never dials out.

### Will it store my secrets?

It stores a **path**, a **kind** and a **fingerprint**. Never a value. The event
schema refuses a digest field holding more than 128 characters, because that is the
shape of a payload that escaped.

### What happens if Memnox is not running?

The interceptors evaluate in process — same rules, a little slower. If the rules
cannot be read at all, that is reported as unreadable rather than as "no rule covers
this", because those are very different sentences.

### Can an agent get around it?

Yes, in the ways named in the [threat model](threat-model.md). `PATH` is advisory: an
agent calling `/usr/bin/git` directly never meets an interceptor. That is what the OS
guard, the git hooks and the MCP proxy are for, and none of them closes it completely.

### Why does it start in observe?

Because a tool that denies something important on its first day gets uninstalled on
its first day. Observe records the real verdict and applies nothing. Look at a few
days of `memnox timeline`, then `memnox protect --enforce`.

### Why is there no risk score?

A single number is unarguable, and an unarguable number is one nobody acts on. There
are counts by severity and a band that names every rule that fired.

### Does it review my code?

No. Memnox rules on an action an agent says it intends to take. It has no diff
scanner and no opinion about your work.
