# ADR 0002 — Telemetry is off, and stays off unless you turn it on

**Status:** accepted
**Date:** 2026-09-05
**Task:** OSS-8.9

## Context

The product's whole claim is that nothing leaves your machine. A scan reads your agent
configs, your credential paths and your MCP servers; the ledger records what your
agents did. Any reporting at all is in tension with that claim.

## Decision

**`telemetry = false` in the config, written on first run, and nothing is ever sent
while it is false.** There is no "anonymous by default", no first-run prompt that
defaults to yes, and no separate opt-out.

If somebody sets it to true, what may be sent is **counts only**: how many agents,
how many servers, how many events by effect. Never a path, never a tool name, never a
host, never a digest.

## Why not anonymous-by-default

Because the counts are not the point. A tool that says "nothing leaves your machine"
and then sends something is a tool whose central claim needs an asterisk, and the
asterisk is what people remember.

## Consequences

- We will not know how many people use it, or which detectors matter most. That is the
  cost, and it is accepted.
- No telemetry endpoint ships in 1.0 at all. The config key exists so the answer to
  "does it phone home" is a file you can read, not a promise.
- Revisit only with a concrete question that counts would answer.
