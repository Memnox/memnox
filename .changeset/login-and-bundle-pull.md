---
'@memnox/interceptors': minor
'@memnox/core': minor
'@memnox/proxy': minor
'memnox': minor
---

`memnox login` connects a machine to a workspace, and `memnox sync` pulls the rules that
workspace publishes. Both are opt-in and off by default: with no `~/.memnox/account.json`
this CLI makes no network call at all, and `memnox logout` puts it back.

Enrolment is a device flow, the way `npm login` works — a code, a URL, and a poll. The
same flow serves a laptop and a CI runner, because the machines that most need governing
are often the ones with no browser to redirect. An ed25519 keypair is generated in
process and the private half never leaves it; what comes back is a credential scoped to
that one machine.

A pulled bundle is applied whole or not at all: it is staged, loaded through the gate's
own reader, and only then renamed into place and registered. Every failure — unreachable,
revoked, lapsed, unparseable — keeps the rules already on disk, because a machine that
cannot reach its control plane must carry on enforcing what it last agreed to.

`packages/cli/test/no-network-outside-sync.test.ts` asserts that `src/sync/client.ts` is
the only module that reaches a network, so *no account, no network* stays checkable
rather than believed.
