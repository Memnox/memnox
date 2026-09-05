# ADR 0001 — Windows support is WSL-only for 1.0

**Status:** accepted
**Date:** 2026-09-05
**Task:** OSS-8.5

## Context

The interception model is a directory placed at the front of `PATH` holding one small
executable per binary, plus a Unix domain socket for the daemon. Neither is portable
as written:

- The interceptors are `#!/bin/sh` scripts. Windows does not run them, and `PATHEXT`
  resolution means a `git` with no extension is not found at all.
- The daemon binds a Unix socket. Windows would need a named pipe, which is a
  different API with different permission semantics — and the socket is `0600` today,
  which is how "only you can ask about your rules" is enforced.
- The macOS guard is `sandbox-exec`; the Linux one is Landlock. Windows has neither.
  The equivalent is a job object with restricted tokens, which is a separate project.

## Decision

**Ship 1.0 as macOS and Linux. Document WSL as the supported path on Windows.** Inside
WSL everything works unchanged, because it is Linux.

`memnox doctor` names the platform and says so, rather than half-working.

## Consequences

- A Windows user runs Memnox inside WSL and governs agents running inside WSL. An
  agent running on the Windows side is **not** governed, and doctor says that plainly
  rather than reporting a clean machine.
- The MCP proxy is the one surface that is already portable — it is a Node process
  speaking stdio — so a later Windows port starts from a working proxy and adds a
  named-pipe daemon and `.cmd` interceptors.
- Revisit when somebody actually asks. Building a Windows port nobody is running would
  be the same mistake as shipping an untested one.
