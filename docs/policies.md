# Policies

Rules are plain TOML, so they stay reviewable and diffable. Every field you leave out
matches everything; every field you set narrows.

A file ending `.yaml` is still read, so a rule set you already have keeps working. New
files are written as `.toml`, and a save never changes the format of a file you wrote.

## A rule

```toml
version = 1

[[policies]]
name = "no-force-push-to-main"
description = "A force push rewrites history somebody else may have pulled."

[policies.match]
actions = ["git.push*"]
targets = ["*main*"]

[policies.decision]
effect = "deny"
reason = "main is shared, and a force push loses somebody's work."

[policies.decision.alternative]
action = "git.push"
resource = "a branch"
note = "Push a branch and open a PR."
```

## The three effects

| Effect | What happens |
|---|---|
| `allow` | it proceeds |
| `ask` | it is held until a person answers at the terminal |
| `deny` | it does not run, and the agent is told what to do instead |

There is no fourth. When several rules match, the strictest wins: `deny` beats `ask`,
which beats `allow`.

## Every deny needs an alternative

`alternative` is not decoration. An agent told only "no" abandons the task; one told
what to use instead finishes it. The alternative is resolved from the rule that
denied — it is never invented.

## Matching

| Field | Matches on |
|---|---|
| `actions` | the namespaced verb, e.g. `git.push`, `filesystem.read` |
| `targets` | what it operates on: a path, a branch, a host |
| `agents` | which agent, by product name |
| `environments` | `production`, `staging`, whatever you name |
| `classes` | what the action does: `read`, `write`, `destructive`, `communication`, `unknown` |
| `arguments` | a named argument, e.g. `method = ["POST", "DELETE"]` on `http.request` |

Patterns take `*`.

### Reads and changes under one name

`gh api`, an MCP server's tools and a web request each go by one action name whether they
read or change something. `classes` is how one rule asks about the change and lets the
read through:

```toml
[policies.match]
actions = [ "mcp.*" ]
classes = [ "write", "destructive", "communication", "unknown" ]
```

An action nothing classified counts as `unknown`, so list it where a tool that could not be
read should still be asked about. An `http.request` names its method in `arguments`: `GET`
for a fetch or a search, what `curl` or `wget` was told, the method on the wire at the
egress proxy, and `UNKNOWN` where nothing could read it. A rule narrowed by `classes` or
`arguments` is not written into Claude Code's native permissions, which can only name the
whole tool and would ask about every read.

### Where a command lands

A command's environment is the one it names, as it names it: railway's `--environment`,
kubectl's `--context`, aws's `--profile`, gcloud's `--project`, docker's `--context`, and
`RAILWAY_ENVIRONMENT`, `AWS_PROFILE`, `TF_WORKSPACE` or `DOCKER_CONTEXT` where no flag says.
`vercel --prod`, `netlify --prod` and `stripe --live` are `production`, because the CLI says
so outright. An MCP call names its own in an `environment`, `environmentName`, `env` or
`stage` argument. Nothing is guessed from a name, so a rule lists the names it means:

```toml
[policies.match]
actions = [ "railway.*", "kubectl.*", "mcp.*" ]
environments = [ "prod*", "production" ]
classes = [ "write", "destructive", "communication" ]
```

A command that names no environment never matches such a rule, so pair it with a rule
that has no `environments` if an unnamed one should be refused too. The refusal says
which environment it was, and names the verb table's way forward where the rule only
said to ask somebody.

### The action is the verb *and its flags*

`git push --force` is `git.push-force`, not `git.push`. They are separate on purpose:
a rule about force-pushing must not deny every push, or the gate stops being used. The
cost is that a rule meant to cover the family has to say so — `git.push*` catches
`git.push`, `git.push-force` and `git.push-f`, which is why the example above is
written that way.

`memnox policy test "<the command you mean>"` prints the action it resolved to. Use it
before you rely on a rule; guessing the name is how a rule ends up matching nothing.

### The target is the last thing on the line

What a command is aimed at sits last in CLI grammar, and that is what `targets` sees:
`main` in `git push origin main`, `s3://bucket/key` in `aws s3 rm s3://bucket/key`,
`api-7` in `kubectl delete pod api-7`. A command with nothing after its verb — `git
push`, `git status` — has no target at all, and a rule scoped with `targets` will not
match it.

## Layers

Rules stack: **org**, then **user**, then **project**. An outer layer may seal a domain
by prefix; an inner layer can then only tighten it. A project rule that would loosen a
sealed one is **refused and named**, never silently dropped — a project that thought it
had loosened something and had not would be governed by something nobody can see.

## Schedules

```toml
[policies.match]
actions = ["deploy.*"]
when = "Fri 16:00-23:59"
```

Evaluated in local time, against a moment passed in rather than a clock read, so a
replay gives the same answer.

## Testing a rule

```sh
memnox policy test "git push --force"
```

The command line is classified exactly as an interceptor classifies it, so a rule
about `git.push` matches what you actually type. A namespaced action works too, which
is how the git hooks call it.

Prints the effect, the reason, the rule and the alternative, and exits non-zero on
anything that is not an allow.

## Who may answer an `ask`

Nobody, by name. An `ask` holds the call for whoever is at the terminal, because
naming an approver needs an identity this machine does not have. `approvers` is
accepted and recorded, and routing it to a named person is the cloud's half.

A rule your workspace publishes is stricter about it. When a team rule names
approvers, asks for more than one approval, or carries a rate limit, the pulled copy
of an `ask` is a `deny` on this machine, and an `allow` is left out, because a question
here goes to whoever answers first and nothing here counts calls. Holding it to less
than the team wrote would be the one direction a gate must not fail in.
