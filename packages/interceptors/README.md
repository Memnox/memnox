# @memnox/interceptors

The seams an agent's own actions pass through before they happen. The MCP proxy
governs what an agent reaches *through a server*; this governs what it does
directly — running a shell command, pushing a branch, opening a URL, handing over
a credential — which is most of what a coding agent does.

A verdict nobody is obliged to ask for is advice. These are the seams that make an
agent which was never written to consult anything ask anyway.

## The five seams

| Seam | Binary | What it sits in front of |
|---|---|---|
| shell | `memnox-shell` | `$SHELL -c "<line>"`, which is what an agent's Bash tool calls |
| command | `memnox-intercept` | one PATH wrapper per binary — `git`, `aws`, `kubectl`, `docker`… |
| git credential | `memnox-git-credential` | git asking for a password, before it is handed over |
| egress | `memnox-egress` | an HTTP request or CONNECT, by destination |
| tool hook | (in process) | a `PreToolUse` hook, for hosts that offer one |

Each answers from the same local gate and the same rule files everything else
reads. A seam that could not reach the gate evaluates in process rather than
failing open silently.

## How the PATH wrappers work

`installInterceptors` writes one two-line shell script per binary into
`~/.memnox/bin`, each one `exec`ing `memnox-intercept` with the name it was
invoked as. Only binaries the machine actually has get a wrapper: a shim for an
absent `aws` would answer `command -v aws` and send every script that checks for
it down the wrong branch.

`memnox run -- <agent>` puts that directory first on the agent's `PATH`. It is
never written into a shell profile — the line to add is printed, and the whole
directory is removed by `memnox uninstall`.

## What a seam is allowed to do

- **Hand stdio over untouched.** Anything the agent reads or writes must look
  exactly as it would have without the wrapper, and the real exit code comes back.
- **Record what happened.** `record.ts` writes the row behind `why`, `timeline`,
  `trace` and `collisions`. Best effort and silent on failure: a ledger that stops
  the command is a tool somebody uninstalls.
- **Explain a refusal.** Every deny names the rule and, where the rule has one,
  what to use instead. An agent told only "no" abandons the task.

## What they cannot see

`PATH` is advisory. An agent invoking `/usr/bin/git` by absolute path never meets
a wrapper — which is why the git hooks, the OS guard and the MCP proxy each close
a different part of the same gap. `EGRESS_BLIND_SPOTS` in `egress-seam.ts` says
the same thing about the tunnel: the destination is gated, the body is not.

Apache-2.0.
