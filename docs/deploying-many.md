# Deploying more than one runtime

A runtime is one tenant. It has one audit chain, one rule set, one set of
agents, and it takes no tenant parameter on any route. That is deliberate: it is
what makes an audit chain provable, and it is why two teams cannot share a
process.

A control plane like memnox-cloud reaches many of them. This is how to lay them
out so it can.

## The two shapes

**A port each.** Simplest, and right for a handful.

```bash
memnox serve --port 7466 --data-dir /srv/memnox/orbit
memnox serve --port 7467 --data-dir /srv/memnox/payments
```

The control plane stores one address per workspace: `http://host:7466`,
`http://host:7467`. Nothing else to configure.

**A path each, behind one host.** Right when you want one hostname, one
certificate, and one ingress rule.

```bash
memnox serve --port 7466 --base-path /orbit    --data-dir /srv/memnox/orbit
memnox serve --port 7467 --base-path /payments --data-dir /srv/memnox/payments
```

Each process answers only under its own prefix: `/orbit/v1/policies`,
`/payments/v1/policies`. `/healthz` is served both at the root and under the
prefix, so an infrastructure probe that knows the host but not the tenant still
works.

Point the ingress at them without rewriting the path:

```nginx
location /orbit/    { proxy_pass http://127.0.0.1:7466; }
location /payments/ { proxy_pass http://127.0.0.1:7467; }
```

The prefix is left on deliberately. If the proxy strips it, drop `--base-path`
and you are back to the first shape with extra steps.

`MEMNOX_BASE_PATH` sets the same thing, for images that take no arguments.

## What the data directory must not share

Every process needs its own `--data-dir`. It holds the audit chain, the agent
registry, approvals, decisions and `enforcement.json`. Two runtimes pointed at
one directory will interleave their audit chains and break verification for
both.

The same applies to `--database-url`: one schema per runtime.

## How the control plane addresses them

memnox-cloud stores a `runtimeUrl` per workspace and appends nothing at call
time, so the address you register is the address it calls. When it provisions a
workspace itself it composes `<runtimeBaseUrl>/<workspace id>`, which assumes
the path shape above: a runtime deployed with `--base-path /<workspace id>`.

If you are running the port shape instead, register each workspace by hand with
its own address rather than letting the cloud compose one. It refuses an address
nothing answers on, so a mismatch is reported when you register it rather than
appearing later as an unreachable project.

## Checking it

```bash
curl -s localhost:7466/orbit/healthz            # {"status":"ok"}
curl -s localhost:7466/healthz                  # {"status":"ok"}
curl -s -o /dev/null -w '%{http_code}\n' \
  localhost:7466/v1/policies                    # 404 under a base path
```

The last one is the point: under `--base-path`, the root no longer serves the
API. A 404 there means the prefix is on, and an address without it is wrong.
