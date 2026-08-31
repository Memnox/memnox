# @memnox/discovery

What can act on this machine, what it can reach, what is risky about that, and the
reversible steps that close the worst of it.

No account, no key, no network. Nothing here opens a socket outward and nothing is
transmitted, which is the only reason a security engineer will run it on a laptop that
holds production credentials.

```ts
import { discover, runDoctor, NodeMachineReader } from '@memnox/discovery';

const report = await discover(new NodeMachineReader(), { now: new Date().toISOString() });
const { findings, score } = runDoctor(report);
```

## What it stores

A path, a kind and a fingerprint. Finding a credential requires reading the file it
lives in; the value stays in the process that read it and never reaches disk, a report
or a log. `discover()` also returns `read`, the list of what it opened, so the tool that
inspects credentials can itself be inspected.

## What it never does

No estimated loss. No comparison against other machines. No score that grants or
narrows a permission — the score is a decomposition of the findings and nothing else.
No irreversible change: every harden step states its inverse before it runs.

## Ports

Discovery reaches for the filesystem constantly, so the filesystem is an argument.
`MachineReader` supplies what the machine holds, `HardenWriter` takes what is written,
and `McpLister` enumerates a server's tools over the protocol rather than guessing from
a config. Every detector is then a pure function of what those say.
