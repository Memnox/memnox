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

### I wrapped my servers. Is that enough?

Almost. Wrapping points every server at the proxy; the proxy still needs rules. It reads
`MEMNOX_POLICIES` when set and otherwise the files this machine has registered, so
`memnox mcp wrap` plus `memnox policy use` is enough on its own — no environment
variable, which matters because an editor opened from a dock icon carries none.

`memnox doctor --wiring` says which half is missing, and `memnox explain <agent>` says
it per agent.

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

### Does it replace the security in Hermes, OpenClaw or Ruflo?

No, and it reads what they enforce rather than ignoring it. Hermes filters tools per
server, OpenClaw has allow/deny lists and a container sandbox, Ruflo has signed
manifests and PII filtering. All three are real controls. A tool Hermes excluded is not
reported as reachable through Hermes, and the count it removed is printed beside the
smaller number.

What none of them can see is the other two on the same disk, the credentials underneath
(`~/.aws/credentials`, the `gh` login, the browser profile), and the shell all three
share. They decide what their agent may call; Memnox decides what the machine underneath
lets through. [Harnesses](harnesses.md) has the detail.

### Will it rewrite my config and lose my comments?

No. A JSON config is written whole, because JSON holds nothing a round trip would lose.
Codex's TOML and Hermes' YAML have their two launch lines replaced and every other byte
copied through, so `memnox mcp unwrap` gives the file back byte for byte. Anything that
will not parse is skipped and named, never rewritten.

### What is "combined capability"?

A set of tools that opens a path none of them opens alone: `read_customer`,
`create_customer_export`, `send_customer_file`. Each is ordinary, each passes review on
its own, and holding all three is exfiltration. It is found from tool names by a fixed
verb table — an acquire step, an optional package step, an emit step, grouped by the
subject they act on. No model is involved, and a chain containing a step that is already
destructive is not printed, because those are counted elsewhere.

### Does it review my code?

No. Memnox rules on an action an agent says it intends to take. It has no diff
scanner and no opinion about your work.
