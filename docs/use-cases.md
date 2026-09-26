# What Memnox does for you

Memnox sits between your AI agents (Claude Code, Codex, Cursor, Hermes and the rest) and
everything they can reach: your files, your shell, git, CLIs like `gh`, `railway` and
`stripe`, MCP servers, databases and the web. It does not write code, review pull requests
or replace your CI. It decides, before each action runs, whether the agent may do it.

The idea behind every feature here is one sentence:

> **Broad read, narrow change.** Give an agent enough access to understand your real
> systems, and only enough authority to act on them safely.

An agent that can read production logs, Stripe events and your database can investigate a
real incident on its own. An agent that cannot redeploy, refund or drop a table while it
does that is one you can walk away from.

Every decision is made on your machine, by rules, with no model involved. The same action
always gets the same answer, and `memnox why` can always tell you which rule gave it.

---

## Contents

1. [Getting started](#getting-started)
2. [Investigate production without changing it](#1-investigate-production-without-changing-it)
3. [Let an agent work on its own and walk away](#2-let-an-agent-work-on-its-own-and-walk-away)
4. [Tell Memnox what the task is](#3-tell-memnox-what-the-task-is)
5. [Allow a scope for a while](#4-allow-a-scope-for-a-while)
6. [Be asked once, not every time](#5-be-asked-once-not-every-time)
7. [Write rules about what an action does](#6-write-rules-about-what-an-action-does)
8. [Reads and changes, told apart everywhere](#7-reads-and-changes-told-apart-everywhere)
9. [Keep secrets secret without blocking work](#8-keep-secrets-secret-without-blocking-work)
10. [See what an agent can actually do](#9-see-what-an-agent-can-actually-do)
11. [Hear when something changes](#10-hear-when-something-changes)
12. [Catch dangerous sequences, not only dangerous actions](#11-catch-dangerous-sequences-not-only-dangerous-actions)
13. [Open a stranger's repository safely](#12-open-a-strangers-repository-safely)
14. [Agents started by other agents](#13-agents-started-by-other-agents)
15. [Two agents, one file](#14-two-agents-one-file)
16. [Find out what happened](#15-find-out-what-happened)
17. [Undo what an agent did](#16-undo-what-an-agent-did)
18. [Check that everything is working](#17-check-that-everything-is-working)
19. [What Memnox cannot do yet](#what-memnox-cannot-do-yet)
20. [Command reference](#command-reference)

---

## Getting started

```sh
npx memnox              # see what your agents can reach on this machine
memnox protect --yes    # write a sensible baseline of rules
memnox run -- claude    # start an agent with every protection in place
```

`memnox run` is the recommended way to start an agent, because it puts Memnox in front of
everything: the shell, the network through a local proxy, and a kernel wall when you ask
for one. Agents with hooks (Claude Code, Codex, Cursor, Gemini) are also checked through
their own hooks when you start them normally, which covers files, shell commands and MCP
tools.

A rule has one of three effects: **allow**, **ask** (a person decides) or **deny**. When
two rules disagree, deny beats ask and ask beats allow.

---

## 1. Investigate production without changing it

**The situation.** Yesterday's payments failed. You want an agent to look at GitHub, the
Railway logs, Stripe's events and the database, and tell you why, without copying logs into
the chat for it and without any risk that it "fixes" production on its own.

**What Memnox does.** It lets every read through and refuses every change outside your
machine. The agent reads the pull request, the deployment logs, the payment intents and the
rows it needs, then tells you what it found. If it tries to redeploy, refund, update a row
or merge, it is refused and told to report instead, and it carries on investigating.

**How.**

```sh
memnox mode investigate
```

That switches every agent on this machine to investigation mode. Reads of files,
repositories, logs, databases, APIs and MCP tools go through. Any change outside the
machine is refused: a deploy, a refund, a database write, a merge, a push, a web request
that is not a read, and a write outside the workspace. `memnox mode off` puts your own
rules back in charge.

**What you'll see when the agent crosses the line:**

```
investigation mode: read anything, change nothing outside this machine
Environment: production.
Instead: report: Say what you found and what you would change; a person makes the change.
```

You can build the same thing from your own rules if you want finer control. See
[section 6](#6-write-rules-about-what-an-action-does).

---

## 2. Let an agent work on its own and walk away

**The situation.** You want to say "investigate and fix this, work on your own", go to
lunch, and come back to a pull request, without being asked about every command.

**What Memnox does.** It lets the ordinary work through: editing files, running tests,
committing, pushing a branch, opening a pull request, and reading anything. It stops only
where a mistake cannot be taken back or should be a person's decision: moving money,
deploying, handing out authority, deleting anything outside the machine, and any change in
an environment named like production.

**How.**

```sh
memnox mode autonomous
memnox run -- claude
```

**What you'll see when you come back.** When the session ends, `memnox run` prints one line:

```
session ses_8f29: 47 action(s); 32 file(s) read, 7 changed; gh 14 read, 1 changed;
railway 8 read, 0 changed; 2 stopped; 1 approved; 1 change(s) outside this machine.
memnox report --session ses_8f29
```

`memnox report --session last` shows the whole picture. See
[section 15](#15-find-out-what-happened).

Your own rules still apply on top of a mode. If a rule of yours asks about every `gh`
change, you will still be asked about opening a pull request.

---

## 3. Tell Memnox what the task is

**The situation.** The agent is meant to fix the retry logic in `src/payments`, or only to
investigate an incident. You want Memnox to know that, so an action that has nothing to do
with the task stands out.

**What Memnox does.** It compares every action against the task you declared. A change
outside the paths you named counts as drift, and if the agent keeps drifting the circuit
breaker pauses it. A task declared as an **investigation** is held to reading: any change
outside the machine is refused, and the refusal quotes your own words back.

**How.**

```sh
# For the repository you are in, for any agent working here (12 hours by default)
memnox task set "fix the retry in payments" --paths src/payments
memnox task set "investigate the failed payments" --intent investigate

memnox task show
memnox task clear

# Or for one run
memnox run --task "fix the retry in payments" --paths src/payments -- claude
memnox run --task "investigate the failed payments" --investigate -- claude
```

**What you'll see:**

```
"investigate the failed payments" is an investigation, and this changes something outside this machine.
```

`memnox why` shows the task next to every decision it touched.

---

## 4. Allow a scope for a while

**The situation.** The agent needs to restart and reconfigure the staging service to
reproduce a bug. Clicking "allow" thirty times is not autonomy, and granting it forever is
not safe.

**What Memnox does.** It lets you allow a whole scope, for a limited time. Inside the scope,
anything a rule would have asked about goes through. Outside it, nothing changes. It never
overrules a refusal, and it ends on its own.

**How.**

```sh
memnox allow "railway.*" --env staging --for 30m --reason "reproducing the retry bug"
memnox allow --list
memnox allow --revoke alw_3f9a1c2e
```

You can narrow it further with `--target` and `--agent`. The longest an allowance can last
is eight hours.

**What you'll see.** Every decision it made says who allowed it and until when:

```
moise allowed this until 2026-09-26T10:30:00.000Z (reproducing the retry bug), allowance alw_3f9a1c2e
```

---

## 5. Be asked once, not every time

**The situation.** You allowed `gh pr view` a minute ago. You should not be asked again for
the next pull request.

**What Memnox does.**

* **"Allow for this session"** covers the action you were shown for the rest of the
  session, whichever process asks next.
* **The second yes is the last.** Once you have said yes to the same action twice in one
  session, Memnox stops asking about it for that session. This works whether you answered in
  the terminal, from the workspace, or in the agent's own permission prompt.
* **A delete is never learned.** Two yeses to two deletes are two decisions, so a delete is
  only ever allowed for the exact call.
* A yes to a web request covers that host only, and a yes to an MCP tool covers that
  server's tool only. A new session starts over.

---

## 6. Write rules about what an action does

Rules live in TOML files. `memnox protect` writes a baseline you can edit, and
[policies.md](policies.md) is the full reference. These are the parts that make "broad
read, narrow change" possible:

**By class: read, write, destructive, communication, unknown.**

```toml
[[policies]]
name = "cli-changes-ask"
[policies.match]
actions = [ "gh.*", "railway.*", "stripe.*", "mcp.*" ]
classes = [ "write", "destructive", "communication" ]
[policies.decision]
effect = "ask"
reason = "a person looks at changes to other people's systems"
```

**By what the change does:** `transfer` (money), `deploy`, `admin` (IAM, secrets, roles),
`execute`, `delete`, `send`, `write`, `read`.

```toml
[policies.match]
actions = [ "*" ]
capabilities = [ "transfer", "deploy" ]
```

**By environment.** Memnox reads the environment a command names: railway's
`--environment`, kubectl's `--context`, aws's `--profile`, `vercel --prod`, `stripe --live`,
variables like `RAILWAY_ENVIRONMENT`, and an MCP call's `environment` argument.

```toml
[policies.match]
actions = [ "railway.*", "kubectl.*", "mcp.*" ]
environments = [ "prod*", "production" ]
classes = [ "write", "destructive", "communication" ]
```

**By leaving things out.** A pattern starting with `!` takes matches back out, and
`{workspace}` stands for the directory the agent works in.

```toml
# Ask about every host except the two this project talks to
targets = [ "*", "!api.stripe.com", "!api.github.com" ]

# Refuse a write anywhere but the workspace
actions = [ "filesystem.write", "filesystem.delete" ]
targets = [ "!{workspace}/**" ]
```

To try a rule without running anything:

```sh
memnox policy test "railway redeploy --environment production"
memnox policy test mcp.stripe.create_refund --class write
```

---

## 7. Reads and changes, told apart everywhere

A rule about changes only works if Memnox can tell a read from a change on every surface.
It can:

| Surface | Examples of reads | Examples of changes |
|---|---|---|
| CLIs (gh, railway, stripe, kubectl, aws, terraform, docker, npm, git and more) | `gh pr view`, `railway logs`, `stripe customers list`, `kubectl get pods` | `gh pr merge`, `railway redeploy`, `stripe refunds create`, `kubectl delete` |
| `gh api` | a plain GET, a GraphQL query | `-XPOST`, `--method=PUT`, a field, a GraphQL mutation, a REST merge |
| Databases (psql, mysql, mongosh, sqlite3) | `SELECT`, `EXPLAIN`, `find()` | `UPDATE`, `DELETE`, `DROP`, `COPY ... FROM`, `deleteMany({})` |
| MCP tools | `list_deployments`, `get_logs`, a tool the server marks read only | `redeploy`, `create_refund`, `cancel_subscription` |
| Shell | `cat`, `grep`, `ls` | `>`, `>>`, `tee`, `sed -i`, `mv`, `touch`, `rm` |
| The web | GET | POST, PUT, PATCH, DELETE |

Some details that matter:

* A statement is read in full, including every `-c`, a heredoc, and the file given to
  `psql -f`. A `DROP` hidden after a semicolon inside quotes is still a `DROP`.
* Flags before the verb do not hide it: `kubectl --context prod delete pod x` is a delete.
* A database MCP tool is judged by the SQL it was handed, not by being called `query`.
* An MCP server's own "read only" and "destructive" hints are believed over the tool's name.

---

## 8. Keep secrets secret without blocking work

The aim is not "an agent may never know a secret exists". It is "an agent cannot read or
send the secret itself".

* **Names are fine.** `memnox scan` and the agent can see which credentials exist
  (`~/.aws/credentials`, `STRIPE_API_KEY`), never their values.
* **Key files are refused:** `~/.ssh`, `~/.aws`, `~/.gcloud`, `~/.kube`, `.env` and `.env.*`.
* **Templates are readable:** `.env.example`, `.env.sample` and `.env.template` hold names,
  not values, and reading them is how an agent learns the shape.
* **Printing a key counts as reading it:** `env`, `printenv`, `export -p` and
  `echo $STRIPE_SECRET` are refused like the file would be. Using a key, such as passing it
  to `curl`, is left to the egress check, which refuses a request carrying a key shape.
* **A key followed by a send is caught.** See [section 11](#11-catch-dangerous-sequences-not-only-dangerous-actions).

---

## 9. See what an agent can actually do

**"What exactly can Claude reach?"**

```sh
memnox explain claude-code
```

This lists every system the agent reaches (each logged in CLI, each MCP server), with its
reads and its changes counted by what your rules would do with them:

```
What it may do in each system
System         Reads                    Changes
gh             all 42 allowed           all 70 asked
railway        all 11 allowed           all 29 asked
stripe (MCP)   all 12 allowed           3 refused, 2 asked
```

It also shows the hosts the agent has reached through the egress proxy.

**"What does this MCP server hold?"**

```sh
memnox explain railway
```

Each tool is listed with what it does (read, write, deploy, delete...), what a call to it
would meet under your rules, and which rule decides it.

---

## 10. Hear when something changes

Keep the daemon running (`memnox setup` starts it) and it tells you when an agent's reach
changes, with a desktop notice and a row in the ledger:

* **A new MCP server**, with how many of its tools read, write and delete.
* **A server that grew a tool that changes things**, the moment it lists it, and whether any
  rule covers it. This is caught by the MCP proxy, so it needs no rescan.
* **A server that disappeared** from an agent's config, or one that **stopped** while an
  agent was using it.
* **Authority that grew**: an agent that can now change a system with nobody asked, where
  before it could only read it.
* **A CLI newly logged in**, which any agent with a shell can now use.
* **A credential that now names production**, such as a kubectl context called `prod-eu-1`.
  Memnox matches the name, so it says "named like production", never that it is production.

---

## 11. Catch dangerous sequences, not only dangerous actions

Some actions are fine on their own and dangerous together.

* **Read a secret, then send.** Reading a credential and then making a request outward asks
  a person. If the request carries a key shape, it is refused.
* **Instructions hidden in content.** When something the agent read (a web page, a README,
  a file, a command's output, an MCP result) says things like "ignore previous
  instructions", the session becomes wary: for the next while, anything outward or
  destructive asks a person. Memnox does not try to decide whether the text was malicious.
  It limits what can happen next.
* **An investigation that turns into a change.** When a session has only read other systems
  (three reads or more through CLIs or MCP tools) and then makes its first change there,
  such as a refund right after looking at the payment, Memnox asks once.
* **Something the agent has never done before** asks the first time, after a short warm up
  period so day one is not a wall of questions.

---

## 12. Open a stranger's repository safely

**The situation.** You cloned an unfamiliar project and want the agent to explain it. The
README might contain instructions meant for the agent, not for you.

**What Memnox does.** A repository an agent clones starts on probation for seven days.
Inside it:

* reading and changing the workspace goes through, so the agent can still understand and
  run the project,
* the repository's own `.env` files are refused, templates aside,
* an MCP tool that changes something is refused, and reading through it is fine,
* anything else outward or destructive asks, and a write outside the repository asks.

```sh
memnox repo list                 # what is on probation
memnox repo trust ./project      # end it once you have looked
memnox run --untrusted -- claude # the same for a repository you cloned yourself
```

`memnox run --untrusted` adds a kernel wall on macOS and Linux: writes only inside the
repository and temp, home dotfiles and the repository's key files unreadable, and the
network only through Memnox's proxy.

---

## 13. Agents started by other agents

An agent another agent starts can never do more than its parent. If Claude Code launches
Codex from its shell, or you run `memnox run` inside another agent's session, the child is
checked against its own rules and against every agent above it, and the strictest answer
wins. A refusal that came from the parent says so:

```
claude-code, which started this agent, may not do this: claude-code only reads
```

Claude Code's own sub-agents run inside its session and are always checked as Claude Code.

---

## 14. Two agents, one file

When Claude Code and Cursor work in the same repository, the first to write a path holds a
lease on its directory. The second is told who holds it and what they have been doing, and
can wait, take it over (on the record), or stand down. Reads never wait.

```sh
memnox lock --list
memnox collisions
```

---

## 15. Find out what happened

**"What did my agent do while I was away?"**

```sh
memnox report --session last
```

```
Session ses_8f29
files read       32
files changed    7
held             2
approved         1
changed outside  nothing outside this machine
blocked          2

Outside this machine
System         Reads  Changes
gh             14     0
railway        8      0
stripe (MCP)   6      0
```

**"Show me every step."**

```sh
memnox replay            # the last session, step by step, with what changed on the machine around it
memnox timeline --since 1h
```

**"Why was this blocked, or allowed?"**

```sh
memnox why               # the last thing that did not simply go through
memnox why --allowed     # the last thing that did
memnox why <event id>
```

`why` shows the rule, the file and line it lives on, what the action does, the task the
session declared, the three steps just before, and what to do instead.

---

## 16. Undo what an agent did

Memnox takes a milestone of your working tree before an agent's first write in a session,
and before anything destructive.

```sh
memnox rewind --list
memnox rewind --last             # back to before the last milestone
memnox rewind --session ses_8f29
```

A rewind restores tracked files, untracked files, and small ignored files such as `.env` or
local config (a megabyte or less). It never deletes an ignored file created since, never
touches `node_modules` or build output, and it takes a milestone of what it replaces first,
so a rewind can itself be undone. It refuses in the middle of a merge or a rebase.

---

## 17. Check that everything is working

```sh
memnox status             # what is on, and how many servers go through Memnox
memnox doctor --wiring    # whether every seam is installed
memnox doctor --prove     # ask every seam to refuse something, and see what came back
memnox doctor --servers   # start every MCP server and see which ones answer
```

---

## What Memnox cannot do yet

We would rather you hear these from us.

* **Programs that are not agents talking to the web.** A Python or Node script making its
  own HTTP requests is only seen through the egress proxy, which `memnox run` starts. An
  agent started without `memnox run` is still checked on its shell commands, files and MCP
  tools, but not on requests a script makes by itself.
* **What is inside an HTTPS request.** The proxy sees the host, not the encrypted body.
* **The kernel wall** comes with `memnox run`, either `--untrusted` or once
  `memnox protect --os-guard` has written a profile, and never with hooks alone.
* **Learning your workflow.** Memnox suggests an allow rule after you approve the same thing
  several times (`memnox next`), but it does not learn a baseline from what it simply
  allowed.
* **Comparing configuration across environments**, such as a variable that differs between
  staging and production, is not something Memnox does.

---

## Command reference

| Command | What it does |
|---|---|
| `memnox` / `memnox scan` | What your agents can reach on this machine |
| `memnox protect` | Write or edit your rules |
| `memnox run -- <agent>` | Start an agent with every protection in place |
| `memnox mode investigate \| autonomous \| off` | Switch how every agent works |
| `memnox task set / show / clear` | Declare what the agent is here to do |
| `memnox allow` | Allow a scope for a while |
| `memnox policy test "<command>"` | Try a rule without running anything |
| `memnox explain <agent \| server \| cli>` | What something can do, and what your rules say about it |
| `memnox why` | Why something was blocked or allowed |
| `memnox report --session last` | What a session did |
| `memnox replay` / `memnox timeline` | Every step, in order |
| `memnox rewind` | Undo an agent's changes to your working tree |
| `memnox repo list / trust` | Cloned repositories on probation |
| `memnox lock` / `memnox collisions` | Two agents on one path |
| `memnox doctor` | Check the wiring, prove the seams, check the servers |
| `memnox next` | What you could safely hand over next |
