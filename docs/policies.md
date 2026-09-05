# Policies

Rules are plain YAML, so they stay reviewable and diffable. Every field you leave out
matches everything; every field you set narrows.

> The build plan specifies TOML for this file (OSS-3.1). The parser is YAML today and
> the format has not been converted. That divergence is deliberate and open — see the
> note at the bottom.

## A rule

```yaml
version: 1
policies:
  - name: no-force-push-to-main
    description: A force push rewrites history somebody else may have pulled.
    match:
      actions: ["git.push"]
      targets: ["*main*"]
    decision:
      effect: deny
      reason: main is shared, and a force push loses somebody's work.
      alternative:
        action: git.push
        resource: a branch
        note: Push a branch and open a PR.
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

Patterns take `*`.

## Layers

Rules stack: **org**, then **user**, then **project**. An outer layer may seal a domain
by prefix; an inner layer can then only tighten it. A project rule that would loosen a
sealed one is **refused and named**, never silently dropped — a project that thought it
had loosened something and had not would be governed by something nobody can see.

## Schedules

```yaml
    match:
      actions: ["deploy.*"]
      when: "Fri 16:00-23:59"
```

Evaluated in local time, against a moment passed in rather than a clock read, so a
replay gives the same answer.

## Testing a rule

```sh
memnox policy test "git push --force"
```

Prints the effect, the reason, the rule and the alternative, and exits non-zero on
anything that is not an allow.

## On the format

The plan calls for TOML. The current parser reads YAML and reports every problem with
a line number. Converting is a real change — a new dependency, and every existing rule
file rewritten — so it is being decided rather than done quietly. Until then this page
describes YAML, which is what the code reads.
