# Quickstart

Nothing here needs an account, and nothing is sent anywhere.

## See what can act on this machine

```sh
npx memnox
```

That is `memnox scan`. It reads your agent configs, asks each MCP server what it holds,
and prints what is reachable. On most laptops the surprising line is a credential
reachable by three agents nobody granted it to.

```sh
memnox scan --tools            # every tool, by what it does
memnox scan --mcp github       # one server, before you trust it
memnox scan --save             # keep it, so "memnox diff" has a baseline
```

## Write rules

```sh
memnox protect                 # propose reversible steps, change nothing
memnox protect --apply         # write them
memnox protect --revert        # put it all back
```

Test a rule before you rely on it:

```sh
memnox policy test "git push --force"
```

## Put an agent behind the gate

```sh
memnox mcp wrap                # route every MCP server through the proxy
memnox run -- claude           # start the agent with interceptors and a session
```

`memnox mcp wrap` backs up each config first and `memnox mcp unwrap` restores it byte
for byte.

## Start in observe

```sh
memnox config get mode         # observe, on a new machine
memnox protect --enforce       # when the verdicts look right
```

Observe records the real verdict and denies nothing. Look at a few days of `memnox
timeline` before you switch.

## Ask what happened

```sh
memnox timeline                # what the agents did, in order
memnox why                     # why the last refusal happened
memnox why --evidence          # the digests and the outcome behind it
memnox diff                    # what changed since the last scan
```

## Take it off

```sh
memnox uninstall               # interceptors, hooks and wrapping
memnox uninstall --purge       # and the history and rules too
```
