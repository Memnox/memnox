# Connecting a runtime to a control plane

A runtime is complete on its own. Rules in a file, decisions in an audit chain,
nothing leaving the machine. Connecting it to a control plane like memnox-cloud
adds a place to read across several runtimes, mirror the audit log off the box,
and set enforcement without a restart.

Nothing about the local setup changes. This is additive.

## 1. Give it a credential

Keyless local mode exists because loopback is unreachable from anywhere else.
The moment something off the machine has to reach it, that stops being true, so
give it a token first:

```bash
memnox serve --admin-token "$(openssl rand -hex 32)"
```

The runtime refuses to start on a routable host with no credentials rather than
serving admin routes to the network, so this is not optional in practice. It is
also worth doing on loopback: with no keys configured, every management request
is treated as admin, including one presenting an agent token. A token means the
agent you are governing cannot change how it is governed.

## 2. Make it reachable

The control plane calls the runtime from wherever it runs, not from your
browser. `127.0.0.1` is only an address the control plane can use if it is on
the same machine.

- **Cloud on the same machine** (a local control plane): `http://127.0.0.1:7466`
  works as it is.
- **Hosted control plane, runtime on your laptop**: put a tunnel in front of it,
  and register the tunnel's address.
- **Hosted control plane, runtime on a server**: register the server's address,
  behind TLS.

## 3. Register it

In the control plane, register the workspace with the address and the admin
token. It probes the address before storing it, so a typo or an unreachable host
is refused there and then rather than surfacing later as an unreachable project.

Register the **bare address**, not one with a path, unless you started the
runtime with `--base-path`. One runtime serving one workspace needs no prefix.
See [deploying-many.md](./deploying-many.md) for the several-runtimes case.

## 4. What crosses the line

Worth knowing before you connect it:

- The runtime keeps holding the events, decisions and the authoritative audit
  chain. The control plane mirrors the audit log so evidence survives the
  runtime being redeployed or lost.
- Connector grants, project names and membership live in the control plane.
- Rules stay in your file. A control plane can publish a pack into the runtime,
  which writes the file and hot-swaps the engine, and every publish is versioned
  and reversible from the runtime's own history.

## 5. Who owns the enforcement mode afterwards

This is the one that surprises people.

Once connected, the control plane sets the mode. `--enforcement` still wins a
cold start, so a pinned image cannot be talked down remotely, but a push from
the control plane overrides the running value and is stored in
`enforcement.json`.

So after connecting, treat the control plane as the place a mode is decided.
Every change is written into the audit chain as `governance.enforcement`, at
high risk when it weakens any environment, so the runtime still records who
changed what and when.

To keep a runtime's mode entirely local, do not register it. There is no half
state where the control plane reads it but cannot set it.
