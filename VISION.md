# The Memnox build sequence

The architecture this project is built toward, across the open runtime and the cloud
control plane. `ARCHITECTURE.md` describes what the runtime is today; this describes the
intent. Where the two disagree, this is the intent and `ARCHITECTURE.md` is the state.

Eleven phases. Each answers one question, and none can answer its question before the
one above it has answered theirs. Cite a phase by number (`§03` for observe and learn,
`§08` for execution) when a change is answering to it.

> Given this person, this task, this context, this agent, these tools and this moment:
> should this action happen? Everything in the product exists to make that one question
> answerable.

Open: run Memnox against the agents you already use, see what they can reach, stop the
dangerous thing, and cut their authority to what they actually need. Paid: know every
agent in the company, what each may know, who it acts for, and what happens when one goes
wrong. Below is every flow that takes, in the order that lets each stand on the last,
with the objects it stores, the path data takes through it, and the way it fails. The
first four phases need no account, no cloud and no network, which is architecture rather
than a free tier.

Shapes are proposals. Every claim about another product needs verifying before it is
built.

---

## Three layers, and only one of them is a moat

Runtime enforcement is commoditising: the large vendors are shipping open source policy
engines, identity, isolation and kill switches. Agent discovery and continuous evidence
are commoditising from the other side, out of the compliance tools. **The space between
them is not.** Memnox is three layers, and the third is the one nobody else is positioned
to build.

**Memory: what the organization knows.**

- *The question:* who owns this, who approves that, what is frozen, what was decided
  before, which customer this touches.
- *Built from* the systems the company already runs, continuously, scoped per identity.
- *Alone it is* a search product, and a crowded one.

**Authority: what this agent may know and do.**

- *The question:* who is this acting for, under what delegation, with what ceiling,
  holding which capabilities, at which autonomy level.
- *Built from* identity, delegation chains and policy, distributed to every machine.
- *Alone it is* an access control product, and the platforms will ship one.

**Execution: should this happen now.**

- *The question:* given this person, this declared task, this state of the company, this
  agent and this moment, does this specific action proceed.
- *Built from* both layers above meeting a real intercepted action, in under a
  millisecond.
- **This is the moat.** It cannot be built by anyone holding only one of the other two.

**What this rules out.** Charging for the enforcement primitive. A policy engine,
identity, isolation and a kill switch are being given away by companies with more
distribution. Selling those is a losing position; giving them away and selling the
organizational layer around them is not.

**What it rules in.** Every paid feature has to need the graph, the fleet, or another
person. If a capability works on one laptop with no account, it belongs in the open half,
and putting it behind a login is the mistake that gets noticed first.

**The sentence to sell on.** Not agent security and not project intelligence. **Know
every agent, know what it knows, know who it acts for, control what it can do.** Four
clauses, each of which is a phase below.

## The product ships no fictional agent

One decision sits under every screen in the open half: **the demo is the reader's own
machine**. No sample workspace, no seeded billing assistant, no simulated tool call, no
staged attack. The agents are the ones they already run, the repositories are theirs, the
credentials are the ones sitting in their home directory right now. It is a harder
product to build and it is the only version that is convincing in the first thirty
seconds.

**What it forces.**

- **Every screen has to be honest when empty.** With no fixtures there is no pretty
  default state, so a machine with one agent and no findings has to read as a real answer
  rather than a broken page.
- **Discovery has to be genuinely good.** The whole opening rests on correctly
  identifying tools the product does not own, across three operating systems and a dozen
  config formats.
- **Every number is derived.** Nothing on screen can come from a constant, which is also
  what makes the output safe to screenshot and share.

**What it forbids.**

- **No staged attack as the default demo.** A lab that runs a real agent against a
  controlled target is honest only while it is clearly labelled a lab, and it is never
  the thing a first run shows.
- **No estimated loss.** A figure nobody can derive tells a security reader the rest is
  marketing, and they are the buyer.
- **No comparison score.** A risk number is a decomposition of this machine's findings,
  never a rank against other people's machines.

**What it buys.**

- **The README is a recording, not a screenshot.** A real agent asks for a credential, is
  redirected, says it will continue without it, and finishes the task. Nothing staged can
  produce that moment.
- **The findings are shareable.** People post what they discovered about their own setup,
  which is the only marketing this category respects.
- **It cannot be faked by a competitor.** A demo built on somebody else's environment is
  expensive to copy and impossible to fabricate.

## The two minutes

At minute zero there is exactly one aggregate a machine can earn without traffic and
without an account: **what on this machine is already able to act**. Everything else at
that timestamp is a promise. So discovery opens, hardening follows, and the first real
refusal happens inside the reader's own agent while it is doing their own work.

```
$ npx memnox

AI AGENTS            Claude Code, Codex CLI, Cursor, Cline
MCP CLIENTS          Claude Desktop, Cursor, VS Code
MCP SERVERS          github, postgres, filesystem, slack,
                     linear, playwright        60 tools
TOOLS                git, docker, kubectl, aws, gcloud

REACHABLE FROM AN AGENT RIGHT NOW

  !  ~/.aws/credentials      3 agents
  !  ~/.ssh/id_ed25519       3 agents
  !  .env  (2 files)         4 agents
  !  /var/run/docker.sock    2 agents
  !  postgres  production URL   1 agent, write
  !  network  unrestricted      4 agents

7 execution surfaces.  0 policies.  0 records.

  memnox doctor   what is risky and why
  memnox harden   fix it, reversibly
```

```
> fix the failing auth tests

Claude Code   reading src/auth.ts
Claude Code   running npm test
Claude Code   reading .env

  WITHHELD  filesystem.read  .env

  matched      secrets-not-required@v1  (harden, 40s ago)
  reason       This task declared no credential need.
  instead      .env.example is readable.

Claude Code   Understood, I will use .env.example.
Claude Code   running npm test          14 passed
Claude Code   opened PR #842

$ memnox why dec_01JQ2

  1  Claude Code asked to read .env
  2  The file holds an AWS key and a database URL
  3  This agent holds no capability for either
  4  The task it was given needs neither
  5  A readable alternative existed and was named

  -> WITHHELD, and the work finished anyway.
```

| | | |
|---|---|---|
| 0:00 | No account, no key, no network | `npx memnox` and it runs. Nothing is transmitted and no telemetry is on by default, which is the only reason a security engineer will run it on a laptop that holds production credentials. **This is the single most important decision in the plan** and everything in phases 00 to 03 follows from it. |
| 0:20 | Discovery names the workforce and its reach | Agent config, MCP manifests, shell profiles, CI workflows, credential stores, container sockets. It counts what can act and what that can touch. **The only count that is true at minute zero**, because it is read off the disk rather than earned over a day. |
| 0:45 | Doctor ranks it into findings | Each finding names the agent, the resource, the evidence path and the one change that closes it. The risk number is a decomposition of that list and grants nothing, or it becomes the trust score this plan already rejected. |
| 1:10 | Harden fixes it without touching their workflow | Six of eight findings closed by writing policy and seam config, nothing in their repository, nothing in their agent's settings that they did not approve. **Every step is individually revertible and prints its undo.** The one thing that gets this uninstalled is breaking somebody's work at 2am. |
| 1:30 | They go back to their actual task | They do not run a demo. They ask their own agent for the thing they were about to ask it for anyway. Memnox is invisible for every ordinary action, which is the half of the demo people forget to design. |
| 1:50 | The refusal redirects, and the work still lands | The agent is told what it may use instead, takes it, and finishes. **A coding agent will actually follow a named alternative**, and that is the difference between a security tool and a governance layer. Then `why` explains it in five lines. |

**Secrets are fingerprinted, never stored.** Finding a credential requires reading the
file it lives in. **The value never leaves the process** and never reaches disk, a report
or a log; what is stored is a path, a kind and a hash. A shareable report that carried
the shape of somebody's SSH key would be the single worst bug this product could ship.

**The 24 hour version is better and cannot be the opening.** Observe mode produces the
far stronger line, **you granted this agent everything and it used twenty seven percent
of it**. It arrives a day late. Ship both: discovery at minute zero, the usage report by
mail at hour twenty four.

**Not an integration pitch.** Enumerating MCP tools is capability discovery, not a
supported vendor list. The line that lands is **sixty tools, eleven of them destructive,
and nothing is checking any of them**. A count of supported providers is a procurement
checkbox and belongs nowhere near this screen.

## The enterprise first week

The paid product has its own activation moment and it is not the developer's. A security
lead does not care that one laptop is hardened. They care that **nobody in the building
can say how many agents there are**, and the census answers that in an afternoon. Then
the week that follows turns the answer into control.

```
AI WORKFORCE

  427 agents        you were tracking 281

  Engineering  183     Sales        61
  Operations    52     Support      48
  Finance       37     Unattributed 46

WHAT THEY CAN DO

  !  91  no named owner
  !  37  can reach production
  !  18  can read customer records
  !  11  can take a destructive action
  !  46  run somewhere we cannot instrument

WHERE THEY CAME FROM

  runtime enrolment   214    machines running Memnox
  provider APIs        94    seats, apps, coding agents
  CI and pipelines     71    workflow files, OIDC subjects
  vendor products      48    agents inside SaaS we buy

  Every count links to the evidence that produced it.
```

1. **Day 1, inventory.** Every agent, every owner, every reach, with the evidence for
   each. Nothing is enforced and nothing is changed.
2. **Day 2, observe.** Every enrolled install goes to shadow. The unmanaged forty six are
   governed at their credential and their seams are named as absent.
3. **Day 3, simulate.** Draft policies replay against the fleet's own recorded traffic,
   in both directions, naming the agents and the workflows each would touch.
4. **Day 4, harden.** Owners assigned, unused capability removed, brokered credentials
   replacing long lived keys, every step reversible.
5. **Day 5, enforce.** One environment, softest first, with the review queue live and
   delivery into the rooms people already work in.
6. **Day 6, measure.** Coverage, drift between installs, the actions still ungoverned,
   the approvals that took longest.
7. **Day 7, widen.** The first agent that readiness says can hold more authority than it
   has, proposed and approved by a person.

**Why the census is the wow.** The count is derived from four independent sources and
every row links to its evidence, so **the gap between what they thought and what is there
is the finding**, and it is theirs rather than ours. It also cannot be answered by a
runtime, which is what makes it the right opening for the paid half.

**The forty six that cannot be instrumented.** Agents inside products the company buys,
and agents in infrastructure nobody owns. They are governed only through their credential
scope, their provider configuration and a review workflow. **Naming them as ungovernable
is more valuable than pretending otherwise**, and it is the honest half of the census.

**What is not on this screen.** An estimated monthly risk exposure in currency. It is
underivable and it is the line that would lose the security lead who is the buyer, so the
census reports counts and reach, and the plan reports what closes them.

## Where Memnox can actually stand

The engineering question the whole plan turns on, and the one a feature list hides. A
verdict only exists if something has to ask for it, and **most real agents will never
voluntarily call an evaluate function**. Each product has a different seam, some have
none in process, and the plan has to name them one by one rather than say the word
interception.

| Agent | Where it runs | Seam Memnox can hold | Blind to |
|---|---|---|---|
| Claude Code | Developer machine | tool hooks, MCP proxy, shell wrapper, git credential helper, egress | the model's reasoning |
| Cursor, Cline, Roo | Developer machine | MCP proxy, terminal, filesystem, egress | in editor edits |
| Codex CLI | Machine or sandbox | shell, filesystem, git, plus the credentials it was handed | provider side execution |
| Copilot coding agent | GitHub infrastructure | issue assignment, PR gate, required checks, Actions boundary | everything before the PR |
| Linear agent | Delegates onward | the delegation record, plus whichever agent it hands to | its own planning |
| Devin, OpenHands | Own VM | network egress, brokered credentials, the systems it reaches | the whole interior |
| Connector agents | Vendor cloud | MCP if it speaks it, otherwise only the credential and its scope | everything the vendor does |
| Any MCP client | Anywhere | the proxy, every tool call and every tool result | little, this is the best seam there is |
| GitHub Actions | Runners | OIDC exchange, environment protection, the deploy call | steps needing no credential |

**MCP is the flagship seam.** It is the one place that is **provider neutral, already in
the developer's config, and carries both the request and the result**. Every client
speaks it, so one proxy governs Claude Desktop, Cursor and VS Code at once, and the tool
result is where a data to instruction promotion can be caught. Build this seam first and
best.

**The seam that always exists** is **the credential and the network**. An agent that
cannot be wrapped can still be starved: hand it a capability that expires in ten minutes
instead of a key that lives a year, and every system it reaches becomes a place a verdict
can stand.

**Consequence for §01.** The evaluate call is not always inside the agent. Often it is
inside the **tool the agent reached for**, which is the same function called from a
different process. The decision object does not change; the caller does.

---

## The spine

Each phase answers one question, and none can answer its question before the one above it
has answered theirs. The Owns column names the store that phase introduces, which is the
real test of whether it is a phase or a screen. The rule between 03 and 04 is the
product's most important line.

| | Phase | The question it answers | Owns | Buys |
|---|---|---|---|---|
| | **Local. No account, no cloud, no network. This is the open runtime.** | | | |
| 00 | The machine | What can act here, and what can it reach? | agent, surface, reachability, finding, harden step | adoption |
| 01 | The one call | What does a verdict look like, and how is it explained? | decision, explanation, policy bundle | legibility |
| 02 | Interception | How does the verdict reach an agent that never asked? | seam, MCP proxy, capability, lease | truth |
| 03 | Observe and learn | What did they actually do, and what did they never need? | local ledger, frame, usage, lineage, proposal | trust |
| | **The account arrives here, and only because a second person does.** | | | |
| 04 | Census and scope | How many agents are there, who does each act for, and who owns none of them? | org, member, workspace, subject, role, census entry | access |
| 05 | Govern | Which actions should be refused, agreed by more than one person? | policy, proposal, simulation | revenue |
| 06 | Authority | Who is asked, and who can stop it? | approval, delegation, grant, containment | revenue |
| 07 | The graph | How does the company know who answers for what? | node, edge, evidence, source, state fact | moat |
| 08 | Execution | How does work move without anybody chasing it? | workflow, run, step, briefing | moat |
| 09 | Operate | What did it cost, what is covered, what can we prove? | cost event, coverage, incident, export | scale |
| 10 | Autonomy | Can this company safely give its agents more authority? | readiness, level, synthesis, detector | moat |

---

## §00 The machine

The whole first act happens on one laptop with no account. Discover what can act, work
out what it can reach, say what is dangerous, and close the worst of it reversibly. A
developer should get all of this before deciding whether to trust the project at all.

### Tasks

**Discover.**

- **Read what is already on disk.** Agent config, MCP manifests, editor settings, shell
  profiles, CI workflow files, container sockets, cloud credential chains.
- **Identify the kind, not the instance.** Claude Code on four machines is one agent
  kind, or the roster is noise by week two.
- **Enumerate MCP properly.** Every server, every tool, and whether each tool reads,
  writes or destroys, which no client shows anywhere.
- **Never store a secret value.** A path, a kind and a fingerprint. The value stays in
  the process that read it.

**Map the reach.**

- **From each agent, what is touchable.** Files, repositories, MCP tools, network,
  containers, cloud, browser sessions.
- **Counts and names, not percentages.** Forty two thousand files and two SSH keys is a
  fact; eighty seven percent network is a feeling with no denominator.
- **Reachability is transitive.** An agent that can run a shell can reach everything the
  shell can, and stating that is most of the value.
- **Cloud reach is what the credentials permit**, resolved against the provider rather
  than guessed from the file.

**Doctor.**

- **Findings, ranked by consequence.** Each names the agent, the resource, the evidence
  and the single change that closes it.
- **The score decomposes or it does not exist.** It grants nothing, it changes no
  permission, and it is never a rank against anybody else.
- **A shareable report by construction.** Scrubbed as it is generated, not scrubbed on
  the way out, because the second design leaks the first time somebody adds a field.
- **No estimated loss.** Ever.

**Harden.**

- **Propose, apply, revert.** Every step prints its undo before it runs, and a single
  command puts the machine back.
- **Nothing in their repository.** Changes land in Memnox policy and seam config, never
  in a file their team reviews.
- **Default to advise on anything ambiguous.** Breaking somebody's work at 2am is the one
  failure this product does not recover from.
- **Re run the doctor and show the delta.** Which findings closed, which remain, and why
  the remaining ones need a person.

### Data structures

```
Agent {                        // a kind, not a session
  id, kind,                    // "claude-code" | "codex" | ...
  version?, configPaths: string[],
  clients: string[],           // which apps host it
  keypairPath,                 // generated locally
  ownerHint,                   // os user, until confirmed
  firstSeen, lastSeen
}

Surface {
  agentId,
  kind: "shell"|"filesystem"|"git"|"mcp"|"network"
      | "docker"|"cloud"|"browser",
  detectedFrom,                // the file that proved it
  tools?: McpTool[]
}

McpTool {
  server, name, description,
  effect: "read"|"write"|"destructive"|"unknown",
  inferredFrom: "annotation"|"schema"|"name"|"probe"
}

Resource {
  id, kind: "file"|"secret"|"repo"|"db"|"cloud"|"socket",
  path?, fingerprint?,         // hash. NEVER the value
  sensitivity, reachableBy: AgentRef[]
}

Finding {
  id, severity, title,
  agentIds, resourceId, evidence,
  remediation?: HardenStep
}

HardenStep {
  id, kind, seam, description,
  apply, revert,               // both, always
  appliedAt?, revertedAt?, mode
}
```

### Data flow: install to hardened

1. `npx memnox` runs with no account. Everything below writes to `~/.memnox` and nothing
   opens a socket outward.
2. Detectors run per agent kind, each a small module that knows one product's config
   layout, versioned separately because those layouts change without notice.
3. MCP servers are enumerated by **listing their tools over the protocol**, not by
   parsing a config guess. Effect is taken from the tool's own annotation where it exists
   and inferred with a stated method where it does not.
4. Resources are fingerprinted. **The reader of a credential file holds the value in
   memory and writes only a hash**, so nothing downstream can leak what it never
   received.
5. Reachability is computed as a transitive closure from each agent's surfaces, and a
   shell surface short circuits it to everything the user can reach.
6. Findings rank by consequence and by whether the reach is used, which is unknown until
   §03 and is therefore assumed present.
7. Harden writes policy files and seam config, records each step with its inverse, and
   prints the revert command before applying anything.

### Notes

**Detectors are the maintenance burden.** Every one of them depends on somebody else's
undocumented config format. Treat them as a versioned, separately releasable set with a
compatibility table, or a single upstream rename silently empties the discovery screen
and the product looks broken.

**Reading secrets to protect them** is the uncomfortable part of the design, and the
reason the fingerprint rule is absolute. It also argues for the scan being auditable:
**print what was read and why**, so the tool that inspects credentials can itself be
inspected.

**Owner is a hint here.** Locally the owner is whoever is at the keyboard. It becomes a
real edge in §04, and the local record is written so that promotion is an update rather
than a re registration.

*Fails when:* harden is not reversible per step. One over aggressive default breaks a
build at midnight, and the uninstall is permanent.

*Done when:* a developer who has never heard of the product runs one command and learns
something true and uncomfortable about their own machine, then closes most of it in a
second command they can undo.

*Not yet:* anything that needs an account, a network call or another person. All three
arrive at §04 and none of them may creep earlier.

## §01 The one call

The atom is a single function answering whether an action may proceed, and the command
that makes the answer legible. A refusal that cannot explain itself is a 403 with extra
steps, and a refusal with no alternative is an agent that gives up on the task.

### Tasks

**The decision object.**

- **In:** who is acting, what they are doing, what to, where, and the context gathered,
  each block carrying its own trust level.
- **Out:** an effect, a risk level, the rule that matched, a readable reason, and any
  obligations.
- **Three effects, not two.** Allow, withhold, escalate. The third keeps a governed
  system from being a wall.
- **An alternative wherever one exists.** A refusal that names the permitted path gets
  taken, and a coding agent will take it without being asked twice.

**Evaluating.**

- **In process, on cached rules.** No network on the hot path, because a governance layer
  that adds latency is one that gets removed under load.
- **Fail closed by configuration**, with the default safe, the override explicit, and
  both recorded on the verdict.
- **Rules are files**, reviewable and diffable by the team that already reviews
  everything that way.
- **Silence for the ordinary.** Ninety nine percent of calls allow and print nothing, or
  the developer turns it off by lunchtime.

**Why, and why not.**

- **Five lines, not a reasoning dump.** Source, resource, authority, rule, outcome.
- **Built from the match, never regenerated.** An explanation produced after the fact by
  a model is a plausible story about a decision, which is worse than none.
- **Why not, as the reverse query.** Explaining an action before it happens is what
  somebody asks while they are still deciding how to work.
- **Every line traceable** to the rule version or the context block it came from.

**Intent.**

- **A session declares a task.** What the person asked for, and the scope it implies:
  these paths, this repository, this environment.
- **Out of scope is a verdict, not a hunch.** A task scoped to the auth module makes a
  request against the customer table inconsistent by comparison, with no model and no
  guessing.
- **Declared, never inferred in the path.** Intent arrives as data from the client that
  already knows it; anything ambiguous escalates to a person rather than to a classifier.
- **The mismatch is the reason.** A refusal that says this was not part of what you asked
  for is one a developer accepts immediately.

**Approve without leaving.**

- **An escalation is answerable from the terminal.** One command, one id, and the parked
  action continues.
- **Trust once, or trust the pattern**, and the second writes a rule rather than a hidden
  exception.
- **The prompt never blocks forever.** A default outcome and a stated timeout, both
  recorded.
- **Locally, the approver is the person at the keyboard.** It becomes a real approval
  chain in §06 without the interface changing.

### Data structures

```
DecisionRequest {
  subject: { id, kind, onBehalfOf? }
  action,                      // "filesystem.read"
  resource?: { kind, id?, attrs }
  environment, context?: ContextBlock[]
  task?: TaskRef               // what was actually asked for
  idempotencyKey?
}

// Intent as data. Declared by the client, never inferred here.
Task {
  id, sessionId, subjectId,
  statement,                   // "fix the failing auth tests"
  declaredScope: {
    paths?, repositories?, services?,
    environments?, resourceKinds?
  },
  declaredBy: "human"|"agent"|"workflow",
  startedAt, endedAt?
}

// The block that makes injection a data model problem.
ContextBlock {
  source,                      // "README.md", "mcp:github/get_issue"
  trust: "trusted"|"untrusted"|"unknown",
  content
}

Decision {
  id,                          // ULID, assigned locally
  effect: "allow"|"withhold"|"escalate",
  shadowEffect?,               // what enforce WOULD have said
  risk, rule?: { id, name, version },
  reason,
  alternative?: { action, resource, note },
  obligations?, escalation?,
  mode, bundleVersion, bundleStale,
  evaluatedAt, latencyUs
}

Explanation {
  decisionId,
  lines: { claim, evidence: RuleRef | ContextRef }[]
}
```

### Data flow: one evaluation

1. The caller invokes `evaluate(request)` in process. No IO on this path at all.
2. Bundle from memory, then from disk. Locally there is no refresher, because there is no
   cloud yet, and the file is the source of truth.
3. **Untrusted context blocks are stripped of instruction authority before matching.**
   Text an agent read is data; it can be evidence for a rule and can never be the reason
   an action is permitted.
4. Rules matched by action glob, resource predicate, environment. First match wins, ties
   by priority, and **withhold overrides allow** at equal priority.
5. **Scope is compared, not judged.** If the request falls outside the task's declared
   scope, that is a fact the rule can match on, exactly like an environment or a resource
   kind. No model is consulted and none ever will be on this path.
6. The alternative is resolved from the rule, not invented: a rule that withholds a
   resource names the substitute it permits, which is what makes redirection reliable.
7. Mode downgrades the effect and never the reverse. In observe the returned effect is
   always allow and the true verdict lands in `shadowEffect`.
8. The explanation is built from the same match and stored beside the decision, so it is
   identical a year later.

### Notes

**Why shadowEffect.** **The hinge of the whole plan.** §03 has nothing to report and §05
nothing to simulate unless observe mode still computes the real verdict and stores it
beside the permissive one.

**The injection principle.** **Data cannot become authority because an agent read it.** A
type, not a classifier: trust is set by whoever supplied the block, and the evaluator
refuses to treat untrusted content as intent. A detector can be wrong; a type cannot be
talked around.

**Intent, without a classifier.** Asking whether an action makes sense for the task is
the strongest idea in the category and the easiest to build badly. **Declared scope makes
the common case deterministic**: a task about the auth module and a request against the
customer table do not match, and that comparison costs nothing. The ambiguous middle
escalates to a person. Inferring intent inside evaluate would put a model on the hot
path, which this plan forbids everywhere else.

**Redirect beats refuse.** The alternative field is small and does the most work in the
product. It is the difference between an agent abandoning a task and an agent finishing
it under constraint, and it is the whole reason the two minute demo ends with passing
tests.

**Budget.** A p99 under a millisecond in process, which rules out a model call inside
evaluate, permanently.

*Done when:* a real agent on a real task is refused one thing, told what to use instead,
takes it, and finishes. Explained afterwards in five lines.

*Not yet:* enforcement on more than the seams a person has explicitly turned on. Silent
expansion of what is blocked is how trust is lost in one afternoon.

## §02 Interception

A verdict nobody is obliged to ask for is advice. This is how the call gets in front of
agents that were not written to consult anything, and it is the phase most governance
products skip, which is why they end up governing only the agent they shipped themselves.

### Tasks

**The MCP proxy, first and best.**

- **Sit between every client and every server.** One proxy governs Claude Desktop, Cursor
  and VS Code at once, because they all speak the same protocol.
- **Both directions.** The call is checked on the way out and the result on the way back,
  which is the only place a tool result can be caught trying to become an instruction.
- **Tool level policy.** Not the server, the tool: read the issue, yes; delete the
  project, no; post to the channel, ask.
- **Install by rewriting their client config**, reversibly, with the original kept,
  because nobody will hand edit six JSON files.

**The other seams.**

- **One per agent kind, named and tested.** Hooks, a shell wrapper, a git credential
  helper, an egress proxy, a repository gate.
- **Local, never a cloud round trip.** The interceptor calls the same in process
  evaluator, so being on the path costs microseconds and survives any outage.
- **Degradation is declared.** Each seam states what it cannot see, because a governed
  agent with an unwatched side channel is worse than an ungoverned one.
- **Turn on one at a time.** Enforcing everything on day one is how a team turns all of
  it off on day two.

**Capabilities, not keys.**

- **Nothing long lived is handed to an agent.** The broker exchanges a request for a
  lease scoped to one operation, one resource and a few minutes.
- **Ask by operation, not by secret.** Refund create for this customer, not the payments
  key.
- **Every lease is a decision**, so the ledger holds why an agent held a credential and
  for how long.
- **Expiry belongs to the issuer**, never to the agent's good behaviour.

**Egress and destructive shapes.**

- **Destination and payload, both.** An allowed host carrying a credential is still a
  refusal.
- **Cheap and certain only.** Credential shapes, known fingerprints, marked fields.
  General classification is a §09 problem and never sits in the path.
- **Name the field in the refusal**, so somebody can decide whether the rule is wrong.
- **Never silently strip.** Modifying a payload and letting it through is a bug the agent
  cannot see and the reader cannot audit.

### Data structures

```
Seam {
  id, agentId,
  kind: "mcp_proxy"|"hook"|"shell"|"git"|"egress"
      | "broker"|"docker"|"repo_gate",
  mode: "off"|"observe"|"enforce",
  covers: string[],            // action globs it sees
  blindTo: string[],           // declared, shown everywhere
  installedBy: HardenStep, lastSeenAt
}

McpCall {
  id, seamId, client, server, tool,
  argsDigest,                  // hashed, not stored raw
  decisionId,
  result?: {
    bytes, containsInstruction: boolean,
    promotedToIntent: false    // invariant, not a field to set
  }
}

Capability {
  id, agentId, operation,
  scope: Record<string, Json>,
  ttlSeconds, policyId
}

Lease {
  id, capabilityId, agentId, decisionId, target,
  issuedAt, expiresAt, revokedAt?, usedCount
}
```

### Data flow: an MCP tool call, both ways

1. The client's config points at the proxy instead of the server. The original config is
   kept, so uninstall is one command.
2. A tool call arrives. The proxy builds a decision request from the tool's declared
   effect and its arguments, and evaluates in process.
3. Withhold returns a protocol level error the client understands, **carrying the
   alternative in the message**, which is how the agent learns what to do instead.
4. Escalate parks the call and prompts the person at the keyboard. The protocol tolerates
   the latency; a wall does not.
5. Allow forwards to the real server. If the tool needs a credential, the broker mints a
   lease rather than passing a stored key.
6. **The result comes back through the same proxy and is wrapped as an untrusted context
   block.** Instruction shaped content in it is recorded and stripped of authority, never
   executed as intent.
7. Every call and result is written to the local ledger with the arguments hashed, so a
   session can be replayed without storing what was in it.

### Notes

**Why MCP first.** It is the only seam that is **provider neutral, already in the config,
and carries the result as well as the request**. It governs several clients at once, it
is where tool poisoning is catchable, and it is the one place a small team can build
something genuinely better than what the agent vendors ship.

**Why this is its own phase.** Different work from writing an evaluator: proxies,
wrappers, provider credential APIs and a compatibility matrix against products that
change. Folding it into §01 hides the largest engineering risk behind the phrase **one
call**.

**Availability.** Standing on the path makes Memnox a dependency of every agent action.
Two consequences that are not negotiable: **the evaluator stays local**, and every seam
states its behaviour when the runtime is unhealthy, chosen per environment rather than
globally.

**Kill and panic live here.** Both are expressible at this layer and nowhere else. Kill
is revoke leases, close seams, cancel pending calls for one agent. Panic raises every
seam to enforce and denies capability issuance, with a reason, an author and a restore
path. **Neither is a demo feature**; each needs a tested path or it is a button that
fails on the day it matters.

*Done when:* an agent nobody instrumented, on a machine nobody prepared, is withheld in
place and told what to use instead, with the seam and its blind spots stated.

*Not yet:* general data classification or anything probabilistic in the path. Certain and
cheap only, until there is a ledger to measure a detector against.

## §03 Observe and learn

Watch for a day, then say something nobody could have said before: not only what the
agents did, but **what they never needed**. Least privilege written from behaviour rather
than from imagination is the strongest thing the open half can do.

### Tasks

**The local ledger.**

- **Every verdict on disk, in one file.** Queryable, exportable, and the developer's own,
  since there is no account to hold it.
- **Chained, so a local record is still evidence.** Tamper evidence is worth having even
  before anybody else can read it.
- **Arguments hashed, results summarised.** A ledger that stores what an agent read
  becomes the thing worth stealing.
- **Retention is a setting with a default**, because a laptop is not a warehouse.

**The flight recorder.**

- **Not only the verdict.** Intent, context retrieved and its trust, capability issued,
  tool called, result, side effects.
- **One session, one timeline**, reconstructed from rows rather than grepped out of a
  log.
- **Full fidelity on anything withheld or escalated**, sampled on the allowed majority,
  which is where the bytes are.
- **The counterfactual is computed, not imagined.** What the blocked action would have
  reached, derived from the attempt that was actually made and from nothing else.

**Lineage.**

- **Who caused this.** A person, through a tool, through an agent, through a repository,
  through a pipeline, to a system.
- **Propagate where possible, stitch where not.** A correlation id in commit trailers, PR
  bodies and pipeline claims, and time plus actor correlation where nothing can be
  carried.
- **Every hop states its method and confidence.** An inferred hop that pretends to be a
  propagated one is worse than a gap.
- **This is the question nobody else can answer**, and it is why the ledger is worth
  keeping.

**Learn.**

- **Usage against grant.** What each agent was permitted, what it used, and the gap
  between them.
- **Unused is the finding.** An agent granted the cloud and the database that touched
  neither all week is a policy waiting to be written.
- **Propose least privilege as a real policy file**, diffed against what is in force,
  applied only on confirmation.
- **Say the window and the coverage.** Four days is not a year, and a proposal that hides
  its sample size is a trap.

### Data structures

```
Frame {
  id, sessionId, agentId, decisionId?, at,
  kind: "intent"|"retrieval"|"capability"|"tool_call"
      | "verdict"|"result"|"side_effect",
  summary, payloadDigest?, contextTrust?
}

CapabilityUsage {
  agentId, action, resourceKind,
  count, firstSeen, lastSeen,
  distinctResources
}

UnusedGrant {
  agentId, action, grantedVia,
  observedWindowDays, neverUsed: true
}

LeastPrivilegeProposal {
  agentId,
  allow: string[], requireApproval: string[], deny: string[],
  derivedFrom: { windowDays, actions, sessions, coverage },
  diffAgainst: PolicyRef
}

Lineage {
  correlationId,
  hops: {
    at, actorId, actorKind, system, ref,
    method: "propagated"|"claimed"|"inferred",
    confidence
  }[]
}

Counterfactual {
  decisionId,
  attempted: { action, resource },
  wouldHaveReached: ResourceRef[],   // from reachability
  basis: "observed_attempt"          // never speculative
}
```

### Data flow: a day of work becomes a policy

1. Observe mode runs every seam in shadow. Nothing is refused, and each verdict records
   what enforce would have said.
2. Frames land beside decisions, sampled, with arguments hashed. The ledger is a local
   database file, not a log directory.
3. Usage rolls up per agent and action as it is written, so the report is a read rather
   than a scan of the day.
4. Unused grants are the complement: what discovery said was reachable, minus what usage
   says was touched, over a stated window.
5. The proposal is generated as **a policy file in the same format a person would
   write**, so it can be read, edited, committed and diffed. A generated policy in a
   private format is a black box nobody adopts.
6. Lineage is assembled by joining on the correlation id where it was carried, and by
   actor plus resource plus time where it was not, with the method recorded on each hop.
7. Applying the proposal is a harden step: reversible, printed, and re measured against
   the next day of traffic.

### Notes

**The line that sells the project.** **You granted this agent everything and it used
twenty seven percent of it.** It is derived, it is about the reader's own machine, and no
competitor can produce it without doing the same work. Everything in this phase exists to
make that sentence true rather than clever.

**Lineage honesty.** Cross system causation cannot be propagated everywhere. Carrying an
id in a commit trailer and a PR body works; a pipeline claim works; the rest is
inference. **Marking an inferred hop as inferred** is what keeps the feature credible the
first time it is wrong.

**Sample size is part of the answer.** A least privilege proposal from four days of one
developer's work is not a policy for a team. State the window, the sessions and the
coverage on the proposal itself, where it cannot be dropped in the retelling.

*Fails when:* the ledger stores payloads. It becomes a single file containing everything
the agents read, on a laptop, unencrypted, and the product is now the vulnerability.

*Done when:* a day of ordinary work produces a policy file the developer reads, edits,
applies and commits, and their agents keep working.

*Not yet:* anything cross machine. One laptop's behaviour is not an organization's, and
pretending otherwise is what §04 exists to correct.

## §04 Census and scope

The account arrives here, and only because a second person does. It brings the paid
product's own opening: not who signed in, but **how many agents are there, who does each
one act for, and which of them nobody owns**. A runtime cannot answer that, which is
exactly why it is the first thing worth paying for.

### Tasks

**Joining.**

- **Signing in is a navigation to one provider**, because the answer is a redirect and a
  fetch cannot follow one across origins.
- **No open registration.** Accounts are provisioned by an admin or by directory sync,
  and an unknown address is refused by a named code.
- **The local install is adopted, not replaced.** Agents, policies and the ledger already
  exist; joining attaches them to an organization and keeps their ids.
- **Nothing is uploaded silently.** What leaves the machine is listed and confirmed once,
  because the whole trust of the open half rests on it.

**Scope.**

- **Organization, workspace, environment.** Enforcement is a property of the third, which
  is the only reason a ramp is possible in §05.
- **Grants are per workspace**, with organization wide access an explicit flag and never
  a default.
- **Roles stay at four.** Owner, admin, member, agent. A fifth is a customer request, not
  a design.
- **An agent needs a named human owner** before it can be enrolled, because every later
  escalation resolves through that edge.

**The tenancy shape.** An organization holds projects; a project groups the workspaces
and the systems they read; a team is a named group of people inside exactly one project.

- **A project is the work; a team is who does it.** The two nouns sit one path segment
  apart, and a reader who cannot tell which one a description means cannot tell what a
  grant does either.
- **Grants are per project.** Joining a team writes one and leaving never takes it back,
  because somebody may hold it through another team or through an admin's grant.
- **Signing in is a navigation to one provider**, and there is no open registration.
  Accounts are provisioned by an admin, by an invitation, or by directory sync, and an
  unknown address is refused by a named code.
- **A platform provisions tenants; it does not absorb them.** An account contracted to
  run customer organizations stamps each child with the platform that created it and is
  refused past the contracted ceiling. A child is a tenant in its own right: billed on
  its own terms, governed on its own terms, and reaching into one still needs a
  credential there.

**The census.**

- **Four independent sources.** Runtime enrolment, provider APIs, pipeline configuration,
  and the vendor products the company already buys.
- **Every count links to its evidence.** A number a security lead cannot drill into is a
  number they will not repeat to their board.
- **Name the ungovernable.** Agents inside somebody else's product are governed by
  credential scope and by review, and saying so is worth more than pretending.
- **The gap is the finding.** What they were tracking against what is there, which is
  theirs rather than ours.

**Identity in three parts.**

- **The kind** is the product. Claude Code, a coding agent, a vendor's assistant.
- **The role** is the job. Release engineer, support triage, invoice reconciliation.
  Policy is written about roles, because a rule about a product governs nothing useful.
- **The principal** is the person it acts for, and the reason an incident can name a
  human rather than an API key.
- **All three or it is not enrolled.** An agent with a kind and no role and no principal
  is the unmanaged category the census counts.

**The fleet.**

- **Kinds across machines.** Forty installs of one role, with divergent seams and
  policies, drawn as one row with its outliers named.
- **Drift between machines is the finding.** One laptop with the proxy off is the story,
  not the thirty nine with it on.
- **The passport becomes organizational**, answering across every machine rather than
  one.
- **Enrolment is one command with a token**, or nobody past the first ten people will do
  it.

**What arrives, and what changes.**

- **A new MCP server is a supply chain event.** Publisher, requested capabilities, how
  many other installs have it, and how long it has existed.
- **Review before it is trusted.** An unknown publisher asking for shell, filesystem
  write and credentials is held pending a person, not blocked forever.
- **A vendor changing its agent is the same event.** A new model, new tools or new
  retention on a product the company buys triggers a policy review rather than a silent
  expansion.
- **Authority increases are reported as such.** Yesterday four repositories, today
  twelve, cause named.

**The console.**

- **Two scopes, one drawn at a time**, with the way back up as a row rather than a menu.
- **The workforce is the first screen**, because it is what somebody opens the product to
  see.
- **Shape before contents.** Only a query that decides whether a block exists holds the
  page.
- **An error takes the panel, not the shell.**

### Data structures

```
Org         { id, name, slug, plan, ssoDomain? }
Member      { id, orgId, email, name, role, status }
Workspace   { id, orgId, name, slug, purpose, archivedAt? }
Environment { id, workspaceId, key, mode, failOpen }
Grant       { id, workspaceId, subjectId, subjectKind, role, expiresAt? }

// One actor table. A person or a machine.
Subject {
  id, orgId, kind: "human"|"agent"|"service",
  displayName, ownerId,        // required for agents
  publicKey?, environment?,
  registeredVia: "enrolment"|"provider"|"pipeline"
               | "vendor"|"console",

  // The three parts. Policy is written about the role.
  agentKind?,                  // "claude-code"  the product
  roleId?,                     // "release-engineer"  the job
  principalId?                 // the person it acts for
}

AgentRole {
  id, orgId, name, purpose,
  ownerTeamId,
  expectedSurfaces, expectedEnvironments,
  autonomyLevel                // §10 hangs here, not on the kind
}

CensusEntry {
  subjectId?,                  // absent while unmanaged
  source: "enrolment"|"provider"|"pipeline"|"vendor",
  evidence,                    // the record that proved it exists
  reach: { production, customerData, destructive },
  governable: boolean,         // is there any seam at all
  ownerStatus: "named"|"inferred"|"unknown",
  firstSeen
}

SupplyChainEvent {
  id, kind: "mcp_server_added"|"vendor_changed"
          | "capability_widened",
  target, publisher?, requestedCapabilities?,
  priorState, newState, cause,
  review: "pending"|"approved"|"rejected"
}

Install {                      // one machine running the runtime
  id, orgId, subjectIds, hostLabel,
  runtimeVersion, seams: SeamSummary[],
  policyBundleVersion, lastSeenAt
}

// A view, not a table. Assembled from every phase.
Passport {
  subject,                     // §00 / §04
  surfaces, reachability,      // §00
  seams, capabilities,         // §02
  usage, unusedGrants, lineage,// §03
  policies,                    // §05
  delegatedBy,                 // §06
  owner,                       // §07
  spend,                       // §09
  autonomyLevel, readiness     // §10
}
```

### Data flow: a local install joins an organization

1. Somebody runs enrol with a token. The runtime lists exactly what will be sent and asks
   once.
2. Local agent records are promoted to subjects, **keeping their ids**, so the local
   ledger and the organizational one join without a migration.
3. The keypair stays local. The public key goes up, so a stolen server database cannot
   impersonate an agent.
4. The owner hint becomes a real owner edge, confirmed by a person rather than inferred
   from an operating system user.
5. Local policy files are offered as proposals into the workspace rather than applied,
   because one laptop's rules are not the organization's.
6. The install reports its seams and its bundle version on a heartbeat, which is what
   makes the fleet drift view possible at all.
7. Sessions live on the API origin with credentialed requests and an echoed token; a 401
   or 403 means signed out and a network error does not.

### Notes

**Why this moved.** It was §00. Making the open half local first means an account is not
needed until a second person is involved, and **a plan that opens with sign in has
quietly conceded that the runtime cannot stand alone**. Everything that was in the old
§00 about agent identity now happens locally in the new one.

**Ids are the seam.** Local ids must be globally unique from the first run, so promotion
is an update rather than a re registration. Get this wrong and every early adopter loses
their history on the day they invite a colleague.

**One subject table.** Humans and agents differ in how they authenticate and in nothing
else. Two tables means two foreign keys and two code paths everywhere, and the first bug
is an agent skipping a check written only for people.

**Policy attaches to the role.** **Kind, role, principal are three fields and they are
not interchangeable.** A rule about Claude Code governs a product and will be wrong the
moment the company adopts another one. A rule about the release engineer role survives
the tool being swapped underneath it, and it is the only version an incident report can
put a person's name against.

**The census counts what it cannot govern.** An entry exists before a subject does, so
the forty six unmanaged agents are rows with evidence rather than absences.
**Governability is a field, not a filter**, or the dashboard quietly reports only the
agents that were easy.

*Fails when:* enrolment uploads by default. The open half's entire credibility is that
nothing leaves; one silent upload ends that permanently and publicly.

*Done when:* a security lead is handed a number larger than the one they had, every row
of it evidenced, and a named owner is missing from a list they can now work through.

*Not yet:* trust scores and autonomy levels. Both are readings off phases that do not
exist, and a number invented here is one somebody will act on.

## §05 Govern

A rule can now be written, tested, approved by somebody other than its author, and put in
force across a fleet. The ramp from watching to refusing runs one environment at a time.
This is the first phase somebody pays for.

### Tasks

**Writing a rule.**

- **One sentence, not six fields.** What an actor does, where, what should happen, and
  why.
- **Offer what is known.** Actions seen, agents enrolled, environments declared, and the
  least privilege proposals §03 already produced.
- **Rules take cases.** A ceiling that allows, a band that needs a manager, a band that
  needs two, a band that refuses, as one ordered list.
- **The draft reads itself back** as a plain sentence, so the author sees a rule rather
  than a form.

**Testing a rule.**

- **Policies have unit tests**, kept beside the rule and run in the customer's own
  pipeline.
- **The test file is the specification** a non engineer can read: four inputs, four
  outcomes.
- **A change that breaks a test is refused**, in the console as in the pipeline.
- **Fixtures come from the ledger**, so a test is about traffic this company has actually
  seen.

**Simulation and blast radius.**

- **Replay before enforcing**, against the last thirty days of recorded decisions.
- **Report both directions.** What it would newly refuse, and what it would newly permit,
  which is the one people forget to look at.
- **Name who is affected.** Agents, installs, environments and owners, resolved rather
  than counted.
- **Attach it to the proposal**, so the approver reads the consequence and not the
  syntax.

**The ramp and the history.**

- **Observe, advise, enforce, per environment**, read at its softest wherever one state
  is drawn.
- **Proposed, not added.** A screen that said added would be the one lie the product
  could tell.
- **Versions, diffs and rollback.** Every change is a new version pointing back, never an
  edit.
- **Ask it about last Tuesday.** Because policy and grants are versioned in time, the
  historical verdict is a query rather than a feature.

### Data structures

```
Policy {
  id, workspaceId, name, version,
  status: "draft"|"proposed"|"in_force"|"retired",
  match: { actions, environments?, subjects?, when? },
  cases: {                     // ordered, first match wins
    when, effect, risk,
    require?: RoleRef[],
    alternative?: { action, resource, note }
  }[],
  reason, createdBy, approvedBy?, effectiveFrom?, supersedes?
}

PolicyTest { policyId, name, given: DecisionRequest,
             expect: { effect, require? } }

Proposal {
  id, policyId?, diff, state,
  origin: "human"|"least_privilege"|"drift"|"synthesis",
  simulation?, blastRadius?,
  proposedBy, reviewers, decidedBy?, decidedAt?
}

SimulationResult {
  windowDays, evaluated, sampled,
  newlyWithheld, newlyAllowed, newlyEscalated,
  changed: { decisionId, was, becomes, action, subjectId }[]
}

BlastRadius {
  subjects, installs, environments, workflows,
  owners, estimatedMonthlyActions
}
```

### Data flow: draft to in force, across a fleet

1. The author writes one sentence, or promotes a least privilege proposal that §03
   generated on one machine.
2. Save creates a **proposal**, not a policy. It compiles immediately, so a syntax
   failure is refused here rather than at evaluation time.
3. Tests run first. A draft failing its author's own test never reaches a reviewer.
4. Simulation replays thirty days **using the runtime's own compiled evaluator**. A
   second implementation would drift, and the simulation would then be fiction.
5. Blast radius resolves affected agents, installs and owners, through the graph when it
   exists and through the roster before it.
6. An admin approves. Policy written, version incremented, change appended to the chain,
   proposal closed with the approver on it.
7. The bundle is recompiled and signed. Installs pick it up by ETag, and one that cannot
   reach the cloud keeps deciding on its cache and marks every verdict stale.

### Notes

**Cases, not separate rules.** Banded authority is how organizations actually delegate,
and splitting it across four policies means four things to keep consistent. One ordered
case list is also what makes the test file readable as a specification.

**Predicates** compile to a small closed expression form, never to code evaluated at
runtime. A policy language that can execute arbitrary code has moved the security
boundary inside the thing guarding it.

**Time travel is a consequence**, not a feature to build. If policies, grants and
capabilities all carry validity intervals, **what would have happened last Tuesday** is a
query. Design the intervals in from the start or it never becomes possible.

*Fails when:* simulation is a second evaluator in the cloud. It disagrees with the
runtime within weeks, and a customer finds the disagreement in production.

*Done when:* a rule written by one person and approved by another changes a verdict on
forty machines, and the record says who approved it and what it would have changed last
month.

*Not yet:* workflows. A graph that hands out work before a human can be asked is an
automation tool wearing a governance page.

## §06 Authority

A rule covers what is known in advance. Everything else escalates, and every escalation
resolves to a person who holds the authority. This is also where somebody other than the
agent's owner can stop it.

### Tasks

**Escalation and delivery.**

- **Escalate names a target**, resolved from the organization rather than typed into the
  rule.
- **A room, not an inbox.** One string naming the transport and the place, picked from
  what the workspace has connected.
- **Answer in place**, or from the terminal, which is where the person who triggered it
  already is.
- **Deadlines are real**, with a defined outcome, and the safe one is the default.

**The chain of command.**

- **Every agent's authority came from somewhere.** Not an API key, a person, through a
  chain the product can print.
- **Delegation is an object.** Issuer, delegate, authority, scope, expiry, and whether it
  can be passed on.
- **An agent cannot delegate what it does not hold**, checked at issue and again at use,
  so a chain can only narrow.
- **Agent to agent is the same check.** One agent handing work to another is a
  delegation, which makes multi agent systems governable rather than a new category.

**The review queue.**

- **Everything waiting on a human, in one place**, ranked by consequence and by time
  against deadline.
- **Context travels with the question.** What led here, what was gathered, what the rule
  said.
- **Repetition becomes a rule.** The same question answered the same way is a draft the
  queue offers to write.
- **Nothing expires silently.** An abandoned question is an incident, not a gap.

**Stopping things.**

- **Kill one agent, everywhere.** Revoke leases, close seams, cancel pending steps,
  quarantine credentials, across every install, in one recorded action.
- **Restrict rather than only refuse.** Quarantine is read only with no capability
  issuance, which keeps an agent debuggable instead of dead.
- **Panic is organization wide** and needs a reason, an author and a restore path, all on
  the chain.
- **Both are tested paths.** A control never exercised is a control that fails on the day
  it is needed.

### Data structures

```
ApprovalRequest {
  id, workspaceId, decisionId?, runId?, stepId?,
  question, consequence, context: ContextRef[],
  approvers: { kind: "member"|"role"|"resolved", id }[],
  quorum, channel?, deadline,
  onTimeout: "deny"|"escalate"|"allow",
  state, wakeKey
}

Delegation {
  id, issuerId, delegateId,    // either may be an agent
  authority: { actions, ceilings },
  scope, transferable,
  expiresAt, revokedAt?, parentId?
}

AuthorityGrant {
  id, subjectId, workspaceId, actions,
  ceilings: { budgetCents?, maxRisk?, resourceScope? },
  secretHash, mintedBy, expiresAt, revokedAt?
}

ContainmentAction {
  id, workspaceId,
  kind: "kill"|"quarantine"|"panic"|"restore",
  subjectId?, reason, authorId, at,
  effects: { installsReached, leasesRevoked, seamsClosed,
             stepsCancelled, environmentsRaised },
  unreached: InstallRef[]      // stated, never hidden
}
```

### Data flow: escalate to answered

1. A verdict comes back escalate. The cloud creates the request and resolves approvers,
   through the graph once §07 exists and through a configured list before it.
2. **The outbox row is written in the same transaction as the request.** Two writes with
   a crash between them is an approval nobody was ever asked for.
3. A worker drains the outbox and posts to the room, idempotent on request and channel,
   storing the external message id.
4. The control carries a signed token of request id plus nonce, so a forwarded message
   cannot be used by a non approver and a reply cannot be replayed.
5. The webhook arrives, signature verified, response written, quorum recounted. A
   terminal reply lands the same way.
6. Quorum met resolves the request, appends to the chain, signals the wake key, and the
   parked action or run resumes.
7. Otherwise a durable timer applies the timeout outcome as a response with the system as
   actor, so the record never has a hole.

### Notes

**The seam that matters most.** **Delivery is the highest leverage unbuilt thing.**
Recorded and routed is most of the engineering and none of the value; every phase above
six is discounted until a question reaches a person where they already are.

**Containment across a fleet is partial by nature.** A killed agent on a laptop that is
asleep is not killed yet. The action records which installs it reached and **which it did
not**, and the console shows the difference until it closes. A kill that reports success
while one machine is offline is the worst possible lie.

**Chains narrow, never widen.** Checked at issue against the issuer's authority and again
at use, because the issuer's authority may have been revoked since. Both, or a revoked
person leaves a live chain behind them.

*Fails when:* the timeout default is allow. One provider outage approves everything
waiting, and the incident report has to say the governance layer did it.

*Done when:* an action escalates, the right person is asked where they already work,
answers there, and the run resumes with the answer on the record. And one command stops
an agent on every machine, provably.

*Watch for:* an approval surface only a console user can answer. Adoption dies quietly
there, and the metric that shows it is median time to answer, not open count.

## §07 The graph

Everything so far can be configured. This is the part that cannot: an understanding of
the organization that keeps itself current, and that every rule, approval and workflow
reads instead of asking a person to type.

### Tasks

**Taking it in.**

- **Scoped from the start.** A workspace reads named parts of a system, chosen from what
  that system says it holds.
- **Continuously, not on import.** An understanding refreshed by hand is wrong by
  Thursday.
- **A source outlives its connection.** Losing access must not throw away what somebody
  chose.
- **What was read is visible**, and removable.

**What it holds.**

- **Entities.** People, teams, systems, agents, customers, contracts, goals, processes.
  Agents are already present from §04.
- **Edges.** Owns, approves, escalates to, depends on, delegated to, supersedes. The
  edges are the product.
- **Ownership as a query.** For any object and action, who answers, resolved rather than
  configured.
- **Precedent.** What was decided, on what evidence, and what it replaced.

**State, not only structure.**

- **The company has a current condition.** A deployment freeze, an open incident, a
  change window, a contract clause, a customer on hold.
- **State is a policy input.** A merge refused because incident 928 is open and the
  freeze is active is organizational intelligence enforcing an action, which is the whole
  thesis in one verdict.
- **Distributed like rules, not queried like a service.** Facts are small, versioned, and
  carry an expiry, so the evaluator still decides locally in microseconds.
- **A stale fact is visible.** A verdict says which state version it used, so a freeze
  that never propagated is a finding rather than a mystery.

**Asking it.**

- **One surface for people and machines**, same question, same answer, same scoping.
- **Governance questions, not trivia.** Can this agent do that, who can, why can it, what
  changed this week that affects it.
- **Provenance attached.** An answer that cannot say where it came from cannot be acted
  on.
- **Refuse rather than guess.** Silence about a gap is the failure that ends the trust.

**Staying true.**

- **Freshness is a property.** Every fact carries when it was last confirmed.
- **Precedent expires.** A decision whose ground has changed is flagged, not quietly
  reused.
- **Conflicts surface.** Two systems disagreeing about ownership is a finding, not a
  merge.
- **Corrections are cheap** and hold everywhere.

### How the graph is fed

"A connector pages a source" is one line above and most of the cloud underneath it. The
mechanism has its own invariants, and they are the ones that decide whether the graph is
worth reading at all.

**One provider holds every integration.** The credentials, the OAuth apps and the event
delivery belong to a single integration provider, so adding a source is a configuration
act rather than a code change and this codebase stores no provider token, refreshes no
grant, and verifies no provider's own signature. Whose name the consent screen carries is
separate from who holds the grant: an organization may register its own app so consent
names the organization, and the provider still holds the resulting credential. One
exception exists, for an auth shape no OAuth flow can express, and a second provider
wanting direct access is a conversation rather than a precedent.

**A toolkit nobody anticipated is configured, never coded.** One normalizer serves every
provider and finds fields by name rather than by vendor: the link, the title, the body,
the author, the timestamp. A source is found by shape too, so a picker, a history walk
and a permalink all work for a toolkit with no entry anywhere. What cannot be guessed is
named in the workspace's own configuration, and **a payload that still cannot be read is
counted and warned about, once**. Never drop a connector's events silently: a
misconfigured feed and a quiet one look identical otherwise, and the fix is always a
config line.

**Every event carries a resolvable URL.** Evidence that cannot be cited is not evidence,
so an unevidenced meeting or document is rejected at the normalizer rather than stored.

**Author trust is a lookup, never an assumption.** An event is trusted only when its
author resolves to a known person in that workspace; an unrecognised or absent author is
tainted, as are third party source types, and a tainted event is marked as an untrusted
source everywhere it is read. Fail closed, for every provider alike. Classification for
sensitivity happens in the same moment and for the same reason: both are facts about when
the thing arrived, and neither is recoverable later.

**History is walked, not sampled.** A toolkit has streams rather than a history, each
with its own cursor, and a run fetches a bounded number of pages, writes its cursor after
every page, and yields. So a five year channel is many bounded runs rather than one
request that times out, and a process that dies resumes instead of restarting. **Backfill
depth and retention are one decision**: a walk stops at the retention horizon, because
pages beyond it would be imported and then removed by the next sweep.

**Nothing waits for a client to ask.** A sweep finds the live connections, starts the ones
never walked, and advances the unfinished ones, so connecting a source is the only act a
person performs. **A refusal is waited out, not retried**: a scope the grant never asked
for and an endpoint the vendor retired both answer identically for ever, so they are held
rather than spent on every pass. **A toolkit nobody pushes is re-read, not abandoned**,
and a toolkit with a live trigger is never re-read, because a delivery and a re-read are
two paths into the same log.

**Evidence arriving is the trigger for extraction.** Not a timer: a timer runs when
nothing has happened and waits when something has. Every route into the event log meets
at one place and enqueues one extraction per workspace, floored so a busy afternoon
cannot spend the month by lunchtime. **How often that becomes a model call is what the
plan bought**, spread across the month, asked before the pace is spent rather than after.
A workspace that has never produced a proposal is not paced at all, because the pace
protects a month's allowance and a workspace with nothing to show has no month worth
protecting.

**The extractor only suggests.** It proposes candidate decisions and a person approves
them in a review queue before anything reaches the runtime, and the approval records the
authenticated reviewer's name. It is the same rule §10 states about promotion, one layer
down: **a machine may propose, and only a person or a system of record may confirm.**
Confidence never promotes anything, however sure the reader was.

### Data structures

```
Node {
  id, workspaceId,
  kind: "person"|"team"|"system"|"agent"|"customer"
      | "contract"|"goal"|"process"|"document",
  externalRef?: { sourceId, externalId },
  attrs, confidence, firstSeen, lastConfirmed
}

Edge {
  id, workspaceId, from, to,
  kind: "owns"|"approves"|"escalates_to"|"depends_on"
      | "member_of"|"delegated_to"|"supersedes"|"about",
  qualifier?,                  // "github.merge"
  confidence, evidence: EvidenceRef[],
  validFrom, validTo?
}

// Current condition. Distributed to installs inside the bundle.
StateFact {
  id, workspaceId,
  kind: "freeze"|"incident"|"change_window"
      | "contract_term"|"account_hold"|"review_missing",
  scope: { services?, repositories?, environments?, customers? },
  value, ref,                  // "INC-928"
  validFrom, validUntil,       // expiry is mandatory
  version
}

AccessContext { subjectId, roleId, workspaceIds, grants, maxSensitivity }

Answer {
  text, citations: EvidenceRef[],
  withheld: { count, reason }  // never omitted silently
}

ChangeSet {
  window, edges: EdgeDelta[], policies: PolicyDelta[],
  impactedSubjects, severity
}
```

### Data flow: source to answer

1. A connector pages a source and writes raw documents with their external ids. Raw is
   kept, because an extractor improves and yesterday's pass must be redoable.
2. An extractor proposes candidate nodes and edges, each carrying the excerpt it came
   from. Deterministic rules first, a model only for what rules cannot reach.
3. Resolution merges on external reference first, then on normalised identity. **A merge
   is recorded, never destructive**, so a wrong one can be split.
4. Write invalidates every cached ownership answer touching those nodes.
5. `whoAnswersFor(resource, action)` walks owns upward, then approves qualified by that
   action, then falls back to the workspace owner, and returns the chain rather than a
   name.
6. Every read is filtered **in the query**. Filtering after retrieval means the material
   was already in a process answering to a different identity.
7. The answer carries citations and a withheld count, so an agent is told there was more
   it could not see.

### Notes

**Storage.** Relational with recursive walks, plus a vector index for the ask surface.
**Do not start with a graph database.** Ownership resolution is two to four hops, and a
second engine is paid for on day one for a benefit that arrives at year three.

**Lineage feeds it.** §03 already produces cross system causation. Those hops become
edges here, which is how the graph learns that a repository belongs to a team without
anybody drawing an org chart.

**State has a mandatory expiry.** A freeze that outlives the incident it belonged to is
worse than no freeze, because the next one gets ignored. Every fact carries `validUntil`,
the bundle drops expired facts on compile, and a fact still in force after its window is
a finding.

**The memory firewall.** The same store answers differently by role: a support role reads
the customer record without the salary field, a finance role reads it with. **What an
agent may know is governed by the same objects as what it may do**, which is the reason
both live in this phase rather than in a retrieval product bolted alongside.

**Temporality.** Edges carry `validFrom` and `validTo` rather than being deleted, the
same mechanism policy versions use, and together they are what make a historical question
answerable.

*Fails when:* scoping is a filter over the response. That is the design that produces the
breach, and it is invisible in testing because the answers look correct.

*Done when:* an approval chain is read from the graph rather than configured, and nobody
typed it anywhere.

*Order note:* this raises what everything else is worth and must not gate enforcement.
Ship §05 and §06 against configured answers, then let the graph replace the
configuration.

## §08 Execution

Work that keeps moving, with a gate on every route that hands something out. This is
where one real event becomes six governed steps across four departments without anybody
chasing it.

### Tasks

**The vocabulary.**

- **The server publishes the kinds**, their config keys and their branches, so the editor
  cannot draw a shape the engine will not run.
- **Validation is mirrored, not owned.** The rule that would refuse a save shows while
  somebody is still drawing.
- **Triggers are sourced** from what is connected, because a name nobody connected is an
  event that never arrives.
- **The invariant.** Every route to a delegation passes a decision or an approval, and
  one that does not is drawn as broken.

**Handing work over.**

- **Ask the agent what it is.** A handshake before the connection is saved, so the tool
  and its arguments come from the server rather than a guess.
- **Dispatch carries four things.** The objective, the context with its trust levels, the
  constraints, and a capability rather than a key.
- **Some agents only ask.** One that cannot be handed work is still worth registering,
  because the connection holds the grant.
- **Memnox never does the work.** No step writes the code or issues the refund.

**Running it.**

- **Durable and resumable.** A run waiting three days on a person survives a deployment.
- **Retries and cancellation**, both explicit, both recorded, neither silent.
- **Replay step by step**, the same drawing walked through what actually happened.
- **Failure has an owner.** A blocked or broken run becomes an incident with a name on
  it.

**Fan out.**

- **One fact, many departments**, each step with its own gate and owner.
- **Handoffs carry state.** The next person receives the work, not a link to it.
- **Schedules are first class.** Most of what an organization does is periodic and lives
  in somebody's head.
- **Nothing runs unattributed.** Every step names the authority it acted under.

### Data structures

```
Workflow { id, workspaceId, name, version, state, nodes, edges }

WFNode {
  id,
  kind: "trigger"|"context"|"decision"|"approval"
      | "delegate"|"branch"|"transform"|"terminal",
  config, position
}

Run {
  id, workflowId, workflowVersion,  // pinned at start
  workspaceId, triggerEvent, correlationId,
  state, cursor, startedAt
}

Step {
  id, runId, nodeId, attempt, state,
  input, output, error?,
  decisionId?, approvalId?, leaseId?, wakeKey?,
  startedAt, endedAt
}

Briefing {
  runId, stepId, objective,
  context: ContextBlock[],          // trust carried through
  constraints: { deadline?, budgetCents?, allowed, forbidden },
  capability: { token, expiresAt, scope },
  correlationId,                    // lineage survives the handoff
  callback: { resultUrl, mcpUrl }
}
```

### Data flow: event to delegation

1. An event arrives on a trigger's source. A run is created with the **workflow version
   pinned**, so publishing a change never mutates a run in flight.
2. The engine takes the next node and writes a step row as pending before doing anything.
   A step that exists only in memory vanishes on a restart.
3. Execution is keyed by run, node and attempt, carried as the idempotency key on every
   outbound call, so a retry after a timeout cannot double send.
4. A decision node calls evaluate and stores the decision id. A delegate node whose path
   carries no gate **cannot exist**: the save was refused.
5. An approval node parks: state waiting, wake key written, durable timer set. The engine
   holds no thread and no memory for it.
6. A delegation requests a capability from the broker, attaches it and the correlation id
   to the briefing, posts it, and parks on the callback.
7. Resolution signals the wake key, the engine reloads from rows and advances. The only
   durable state is the step table.

### Notes

**The invariant, mechanically.** Validation walks **backward from every delegate node to
the trigger**. If any path reaches the trigger without crossing a decision or an
approval, the save is refused. The console mirrors it while drawing; the server enforces
it regardless.

**Context trust survives the handoff.** Blocks keep their trust level into the briefing,
so an agent receiving work knows which parts of its context are quotations from the
outside world. Losing that at the boundary reopens the injection path §01 closed.

**Correlation travels too.** The same id §03 uses for lineage rides in the briefing, so a
delegated run shows up as a hop rather than as an unexplained new actor.

*Fails when:* the engine keeps run state in process. It works until the first deployment
during a waiting approval, and then a customer's contract sits in a run that no longer
exists.

*Done when:* one real event sets six governed steps running across four departments, each
with an owner, a gate and a record.

*Not yet:* a step that acts on a connected system directly. A connector is what a trigger
listens to and what a context step reads, never a hand that does the work.

## §09 Operate

The questions the buyer answers for internally: what is covered, what did it cost, and
what can we hand an auditor. None are engineering questions and all are asked of
engineering today.

### Tasks

**Coverage.**

- **Governed against ungoverned**, per workspace and per agent, moving week on week.
- **Seam coverage counts too.** An agent governed on one of four seams is not a governed
  agent, and the number has to say so.
- **Install drift is coverage.** Thirty nine machines enforcing and one not is a hole,
  not a rounding error.
- **One number a board can see**, defended by the list underneath it.

**Cost.**

- **Per workspace, per agent, per model.** Attribution before optimisation.
- **Ceilings that bite.** A limit that only warns is discovered in an invoice.
- **Keys are write only across the seam.** What comes back is whether one is configured,
  not what it is.
- **Say when the deployment is paying.** A workspace quietly spending someone else's
  credit surprises both sides.

**Evidence.**

- **An export an auditor accepts**, shaped for the regimes the buyer is already under.
- **Automated decisions, listed.** What a machine decided, under what authority, with
  what oversight.
- **The chain travels with it.** Evidence that cannot be verified outside the product is
  a screenshot.
- **Continuous, not assembled.** Producing it must not take a person a week.

**Drift and chains.**

- **An agent that was safe last week may not be.** The model changed, the prompt changed,
  a tool was added, a permission widened, a vendor shipped something.
- **Compare against its own baseline.** New capabilities, new destinations, new tools,
  measured against seven days of that agent's own behaviour.
- **Chains are invisible one action at a time.** One agent reads a credential hint, a
  second touches a repository, a third reaches the cloud. Each is permitted; together
  they are an escalation.
- **Detect on the lineage, not on the action.** Which is why §03 exists and why this
  cannot be done by a runtime alone.

**Anomaly and incident.**

- **Normal is per agent**, learned from its own history rather than from a global
  threshold.
- **Detection proposes containment; a person confirms it,** until the ledger shows the
  detector is right often enough.
- **An incident is an object**, with a timeline, an owner, the containment taken and the
  snapshot preserved.
- **Out to their systems.** Sinks and webhooks, and no third seam.

### Data structures

```
CostEvent {
  id, workspaceId, at, subjectId, runId?, stepId?,
  model, inputTokens, outputTokens, cents,
  payer: "workspace"|"deployment"
}

Ceiling {
  workspaceId, scope, scopeId, window, limitCents,
  onBreach: "withhold"|"escalate"|"notify"
}

CoverageWindow {
  workspaceId, from, to,
  actionsSeen, actionsGoverned,
  seamsCovered, seamsTotal,
  installsEnforcing, installsTotal,
  byRisk, topUngoverned
}

DriftBaseline {
  subjectId, windowDays,
  surfaces, destinations, tools, models,
  computedAt
}

DriftFinding {
  subjectId, against: DriftBaseline,
  added: { surfaces, destinations, tools, models },
  cause?,                      // "mcp_server_added: some-server"
  authorityDelta, severity
}

ChainFinding {
  correlationId,               // from §03 lineage
  hops: { subjectId, action, at }[],
  pattern: "privilege_escalation"|"data_movement"
         | "credential_relay",
  severity, containmentProposed
}

Incident {
  id, workspaceId, subjectId, openedAt, severity,
  detector?, frames: FrameRef[],
  containment: ContainmentAction[],
  ownerId, state, snapshotRef
}

EvidenceExport {
  id, workspaceId, from, to, includes,
  manifest: { file, sha256, rows }[],
  checkpoints, signature
}
```

### Data flow: a ceiling that bites

1. Every dispatch and model call writes a cost event attributed to a subject, a run and a
   step.
2. A counter per scope and window is incremented on write, so current spend is a read of
   one row rather than a sum.
3. **The ceiling is a policy input, not a separate switch.** Spend crossing the limit is
   an obligation the evaluator reads, so a breach produces a verdict with a reason
   instead of an unexplained failure elsewhere.
4. On breach the configured effect applies: withhold, escalate to a person, or notify and
   continue.
5. Provider keys go up write only; what comes back is configured, whether the deployment
   key is in use, and a four character hint.
6. An export streams the range out of the day partitions, hashes each file into a
   manifest, attaches the chain checkpoints, and signs it so it verifies without the
   product.

### Notes

**Coverage, defined.** **Distinct actions governed over distinct actions seen, weighted
by risk, times seam coverage, times install coverage.** A read loop otherwise shows
ninety nine percent while every irreversible action in the company is ungoverned.

**Cost, stated** relative to a base model, never in currency in the interface. A price
per token belongs to the provider and changes without telling us.

**Detector discipline.** Every detector is scored against the ledger before it acts
alone, and a dismissal tunes it for that workspace. A detector nobody measured is a mute
button waiting to be pressed.

**Drift needs a cause, not an alarm.** A widened agent is usually somebody installing a
tool, not an attack. **The finding names the cause** from the supply chain events in §04,
so the common case reads as a change to approve rather than a threat to investigate, and
the rare case stands out because everything ordinary has an explanation attached.

**The chain view is the one thing a runtime cannot do.** Every hop is individually
permitted, so no local evaluator will ever see it. It requires the fleet ledger and the
lineage joined across systems, which is the clearest technical argument for why the paid
half exists at all.

*Fails when:* reporting describes the product rather than the organization. Every number
here is about the company's own behaviour; feature usage belongs in an internal dashboard
nobody sells.

*Done when:* a finance lead and a compliance lead each get their answer without asking
engineering for anything.

*Not yet:* automatic containment without a person. It becomes safe only once the detector
has a measured record, and never before.

## §10 Autonomy

Every phase before this restricts. This one is why a company keeps paying: it is the only
system in the building that can say, with evidence, that an agent can safely be given
more authority than it has.

### Tasks

**Levels, not scores.**

- **Autonomy is a small ladder.** Observe, suggest, act reversibly, act within bounds,
  act autonomously, hold delegated authority.
- **A level is a policy bundle**, not a number in a field, so what it permits is readable
  and testable.
- **Movement is proposed and approved**, exactly like any other policy change, with the
  same simulation attached.
- **Down is automatic, up is not.** An incident can demote on its own; nothing promotes
  without a person.

**Readiness.**

- **A checklist, not a score.** Owner, policy coverage, seam coverage, install coverage,
  brokered credentials, rollback, budget, escalation path, audit, tests.
- **Every item is a query** against something already stored, so the answer cannot be
  aspirational and nobody can tick it.
- **It names the blockers and the change that closes each.**
- **Per agent and per organization**, because one unready agent is a different problem
  from an unready company.

**Learning from the queue.**

- **Repeated identical approvals are a rule waiting to be written.** Support and
  agreement both clear a bar, and one dissent resets it.
- **The draft is an ordinary proposal**, simulated the ordinary way. Nothing gets a
  private path into policy.
- **Denials are as informative as approvals.** An agent repeatedly refused something is
  misconfigured or missing an alternative.
- **Least privilege and synthesis are the same idea** at two scales: unused capability
  narrows a grant locally, repeated approval widens a rule organizationally.

**What widening is worth.**

- **Cost per completed task, not cost per token.** Spend joined to the runs and the
  outcomes it produced, per role.
- **Intervention rate is the honest measure.** How often a human had to step in, falling
  or rising, per role, week on week.
- **Waste is visible.** Retried, abandoned and refused actions, priced, which is usually
  where a large bill is actually going.
- **Value is the customer's assumption, never ours.** They supply the rate; we supply the
  counts, and the number is labelled as theirs.

**The flywheel.**

- **More governed actions** means a better picture of what normal is.
- **A better picture** means tighter rules and fewer unnecessary approvals.
- **Fewer approvals** means the organization safely raises a level.
- **A raised level** means more agents doing more, which returns to the top. This is the
  moat, and it only turns if every phase under it is honest.

### Data structures

```
AutonomyLevel {
  key: 0..5, name,
  policyPackId,                // what the level actually means
  requires: ReadinessItem[]
}

ReadinessItem {
  key,                         // "owner" | "seam_coverage" | ...
  query,                       // evaluated, never asserted
  status: "met"|"unmet"|"unknown",
  blocker?, remediation?
}

LevelChange {
  subjectId, from, to,
  direction: "promote"|"demote",
  cause: "proposal"|"incident"|"expiry",
  proposalId?, incidentId?, decidedBy?, at
}

RuleSynthesis {
  id, workspaceId, fromApprovals: string[],
  support, agreement,
  proposal: Proposal           // §05 object, unchanged
}

// Measured, except the last field, which the customer supplies.
RoleEconomics {
  roleId, window,
  actions, tasksCompleted, tasksAbandoned,
  interventions, interventionRate,
  retriedActions, refusedActions,
  cents, centsPerCompletedTask, wastedCents,
  humanRatePerHour?            // their assumption, labelled
}

Detector {
  id, kind: "stalled_handoff"|"duplicate_effort"
          | "orphaned_ownership"|"behaviour_shift",
  schedule, params, precisionToDate
}
```

### Data flow: an agent earns a level

1. Readiness runs as a set of queries over stores that already exist. Nothing is asserted
   by a person, so the checklist cannot be talked into passing.
2. An unmet item names its blocker and the change that closes it, resolved to an owner
   through the graph.
3. When every item is met, the console offers a promotion. **The offer is a proposal**
   carrying the level's policy pack as its diff.
4. Simulation replays the window against that pack and reports both directions: approvals
   removed, and actions newly permitted.
5. A person approves. The change is recorded with its cause, and the passport shows the
   new level and who granted it.
6. An incident demotes without waiting for anybody, records the cause as incident, and
   the way back is the ordinary proposal path.
7. **Trust never widens authority on its own.** It is evidence in front of a person, and
   the moment it becomes an automatic grant the product has removed the accountable human
   it sells.

### Notes

**Why levels beat a score.** A scalar that silently widens permission is unauditable and
impossible to explain to a regulator. A level is a named bundle of rules: readable,
testable, diffable, revocable, and granted by a person.

**Readiness is queries.** Every item resolves against §00 to §09. That is also the honest
reason this phase is last: a readiness checklist over stores that do not exist is a
questionnaire.

**The one measure.** **Approvals removed without a rise in incidents.** One number,
reported per workspace, and the only defensible claim that the intelligence layer is
worth its price.

**Two kinds of number, kept apart.** Actions, interventions, retries and spend are
**measured**. Hours saved and value delivered are **modelled** from a rate the customer
sets. Presenting the second kind in our own voice is how a governance product acquires
the credibility problem of a marketing deck, and it is the same mistake as an estimated
risk exposure.

**Standing limit.** Self proposing is the ceiling in perpetuity. There is no version of
this product that enacts its own rules.

*Done when:* a company that could not have said whether its agents were safe to widen can
now say so, name the three things stopping it, and act on the answer.

*Watch for:* autonomy theatre. A promotion no simulation supported, or a readiness item a
person can tick, and the phase becomes a certificate nobody believes.

---

## What no phase owns

Four things the cloud carries that the ladder above never asks for. They are not phases,
because nothing waits on them and they answer no question in the spine. They are here
because a surface the intent does not describe is a surface nobody can argue with.

### Billing

**The organization is billed, never the project.** A company running four projects buys
one subscription and allowances pool across all of them. That question is answered in one
place, and the corollary is that **there is no second copy of the plan anywhere**: seats
come from the entitlement, and no other record carries a plan or a seat count. Both
existed once, nothing kept them in step, and an organization paying for a five seat plan
had its invitations gated on the free plan's one.

**There are two ladders, not five rungs.** A company using Memnox for itself is priced per
person. A company whose product is AI that works inside other companies is priced on what
it deploys. Never put a platform on a per seat plan: a company with a hundred staff and
ten thousand AI workers priced per worker does not buy, and priced per person is a company
paying for the wrong side of its business. **What makes an account a platform is a number,
not a flag**, and the contracted number wins over the tier's, because a contract is a
negotiation rather than a rung.

**Seats and AI workload are separate meters.** Seats price people; governed actions price
what the AI does. Sizing an agent workload against an extraction number gives the wrong
answer in both directions, because extraction spends model tokens and a governed action
costs this control plane nothing.

**One matrix is the single source of truth** for every price, limit and flag. The pricing
page, the console and the payment provider all render from it and nothing holds a copy;
the price list is published unauthenticated, because a price list is published. What a
customer pays is sent with the checkout rather than read off the payment provider's own
record, so a stale price in a dashboard cannot disagree with the page or with what the
gate enforces. **Metered limits on a per seat plan are per seat**, and comparing a whole
team's usage against one seat's worth refuses them at a fraction of what they bought.

**Top-ups raise a number; they never unlock a capability.** And **quotas are answered in
one place**, never hand rolled at a call site.

**Never gate a safety feature.** Policy enforcement, approvals, the hash chained audit
log, secret and PII scanning and prompt injection defence are free on every tier and open
in the runtime. What is priced is organizational scale: ingestion, extraction, the cross
team graph, roles, compliance export. Charging for the enforcement primitive is the
losing position named at the top of this document, and a paywall on a safety control is
that mistake in its most visible form.

### Bring your own key

Which model a workspace runs on and whose key pays for it is one decision with three
rules. **The key is not on the workspace record**, because that record is returned whole
to anyone who can list workspaces; it gets its own store, is encoded at rest, and never
leaves the process. **Resolution is workspace key, then deployment key, and the reader is
told which**, because a control plane that silently fell back to its own key after a
customer's expired would spend our money on their ingestion without either side noticing.
**A model is published only if this deployment can construct it**, and the catalogue
derives its cost labels from the meter rather than restating them, so a price cannot be
right in the bill and wrong in the picker.

### The operator surface

What the people who run this deployment see: every organization, every workspace, every
member, every billing account. It is the one place a cross tenant read is the point,
which is why it is the one place with a guard of its own.

**An organization admin is not an operator.** Admin is the commonest role in the system,
so role alone would hand every tenant owner every other tenant's data. Three ways in and
no fourth: a credential belonging to no organization, an address the deployment declared,
or a user carrying the flag, read live on every request so revoking bites on the next
call. **Only the first two may grant the flag**: one that could mint another copy of
itself would make a compromised session permanent.

**No route here is scoped by the caller's own organization**, deliberately, or an operator
reading another tenant's row would be refused before the guard that matters ever ran. A
test sweeps every route that names no workspace and forces each to be classified as
neutral, hand scoped, or operator only.

### What a person can take back

A subject can be erased and a subject can be exported, per organization, for people and
for the records that name them. This is the one obligation in the product that arrives
from outside it, and a governance product that could not answer it would be selling
something it does not practise.

---

## Open source and cloud

The line is drawn on a principle, not on a feature count, or every quarter is an
argument. **Everything one person needs to govern the agents on their own machine is open
and works with no account.** Anything that only means something across more than one
person, and that needs somebody else's data to work, is the cloud. The transition is not
a paywall, it is the moment a second person arrives, which is exactly where §04 sits.

The competitive reason matters as much as the principle. **The enforcement primitive is
being given away by companies with more distribution**, so a policy engine behind a login
is a losing position within a year. Give away the engine, sell the organization around
it: the census, the roles, the state, the chains, the evidence and the autonomy decision.

| Capability | Open runtime | Cloud | Why the line falls here |
|---|---|---|---|
| Discovery, map, doctor, harden | yes | yes | This is the first two minutes. Gating it kills the project. |
| Decision object, evaluator, why | yes | yes | What is embedded has to be inspectable. |
| MCP proxy, seams, broker, egress | yes | yes | Enforcement a developer cannot read is enforcement they will not install. |
| Local ledger, replay, lineage | yes | yes | Their machine, their record, no account to hold it. |
| Observe, learn, least privilege | yes | yes | The strongest thing the open half does. Keeping it back would be the mistake. |
| Kill, quarantine, panic | local | fleet | Safety controls behind a paywall are a bad look and a worse argument. |
| Chained ledger across machines | local only | yes | One chain per organization needs a single writer somebody hosts. |
| Proposal, review, fleet distribution | files only | yes | Approval by another person is a control plane by definition. |
| Approvals into a room, review queue | terminal only | yes | Needs identities, transports and a durable waiter. |
| Organizational graph and ask | no | yes | Built from the company's systems, held per tenant. |
| Fleet view, coverage, spend, evidence | no | yes | Only exists above one machine. |
| Detectors, synthesis, readiness, levels | no | yes | Needs the history of an organization, which is the moat. |
| Census of agents nobody enrolled | no | yes | Provider APIs, pipelines and vendor products, none of which a laptop can see. |
| Role and principal identity | kind only | yes | A role and a person exist only in an organization. |
| Organizational state as a policy input | no | yes | Freezes and incidents come from systems one machine has no access to. |
| Cross agent chain detection | no | yes | Every hop is permitted; only the joined ledger shows the pattern. |
| Third party and vendor agent review | no | yes | Governed by contract and credential scope, not by a seam. |
| Compliance evidence, SSO, SIEM | no | yes | Enterprise plumbing with no meaning for one person. |
| Spend attribution and role economics | no | yes | Cost per completed task needs the fleet's runs and outcomes. |

---

## What we would not build

The reviews produced well over a hundred ideas and most are good. These are the ones to
decline, and the reason matters more than the verdict: each is a place where the product
trades something it can prove for something it cannot.

- **An estimated loss figure.** Prevented eighteen thousand dollars is a number nobody
  can derive. Publishing one tells a security reader the rest of the output is marketing,
  and they are the buyer.
- **A risk score that grants.** A doctor score that decomposes into findings is fine. The
  moment any number silently widens or narrows a permission it becomes unauditable, and
  authority belongs in a named level a person granted.
- **Irreversible hardening.** Every automatic change prints its undo before it runs. One
  over eager default breaking a build at midnight is the failure this product does not
  recover from.
- **Storing what it read.** Secret values, tool arguments and results are fingerprinted
  or summarised, never kept. A ledger holding everything the agents read, on a laptop, is
  the product becoming the vulnerability.
- **A staged attack as the demo.** An attack lab is honest while it is clearly labelled a
  lab. As a first run experience it is a fixture, and this product's whole claim is that
  it uses none.
- **Honeypots and decoys.** A research technique with a false positive problem and no
  buyer. It also invites an agent to do something it would not otherwise have done, which
  reads badly in an incident report.
- **A model in the enforcement path.** Injection classification and data labelling both
  want one. Both sit on the hot path of every action, and the first slow week is the week
  enforcement is switched off. Types and cheap certain checks in the path, models in the
  ledger.
- **Agent negotiation and certification.** Two agents bargaining over an anonymised view
  is a future with no customer, and a certificate is worth what the issuer's reputation
  is worth. Delegation with narrowing scope already covers every case anyone can name.
- **Risk exposure in currency.** An estimated 2.8 million of monthly exposure is the
  enterprise version of the prevented loss figure. The census reports counts, reach and
  owners, all of which are true and all of which are more alarming than a number the
  reader knows was modelled.
- **Value delivered, in our voice.** Hours saved and return multiples are modelled from a
  rate we do not know. Report the measured counts, take the rate from the customer, and
  label the result as theirs.
- **Seventy tabs.** The product answers seven questions: who is it, what does it know,
  what may it do, why, who authorised it, should it proceed, what happened. A console
  that needs a tour has stopped answering them.

## Why this order

Ten constraints hold the sequence together. Each names what breaks if the phases are
reordered around it.

**Local first.** No account until a second person needs one. The open half's entire
credibility is that nothing leaves the machine. A plan that opens with sign in has
conceded that the runtime cannot stand alone, and it will be judged against tools that
install in one command and phone nowhere.

**Discovery.** Discovery precedes everything, because it is the only honest aggregate at
minute zero. A count read off the reader's own disk is true immediately. Every other
number worth showing has to be earned over a day, and a product that promises one at
minute two has lied before it has done anything.

**Interception.** Interception precedes enforcement. A verdict nobody is obliged to ask
for is advice. Most real agents will never call an evaluator voluntarily, so the seam is
the product, and a plan that assumes cooperation governs only the agents it wrote itself.

**Redirect.** A refusal names an alternative. An agent told only no abandons the task and
the developer blames the tool. An agent told what to use instead finishes the work, and
the demo ends with passing tests rather than with a blocked command.

**Intent.** Intent is declared, never inferred in the path. Asking whether an action fits
the task is the strongest check in the category, and the version that infers it needs a
model on the hot path. Take the task as data from the client that already knows it,
compare scope deterministically, and escalate the ambiguous middle to a person.

**Give away.** The enforcement primitive is free, the organization is not. Policy
engines, identity, isolation and kill switches are being open sourced by companies with
more distribution. Charging for those loses within a year; charging for the census, the
roles, the state, the chains and the autonomy decision does not.

**Ledger.** The record precedes the rule. A policy editor opened before there is traffic
to write about is a blank form, and the first customer concludes the product is
configuration.

**Ask.** Approvals precede workflows. A graph that can delegate before a human can be
asked is an automation tool wearing a governance page, and it gets compared to automation
tools on price.

**Latency.** The hot path never waits on the control plane, and never on a model.
Standing on the path makes this absolute rather than advisory. A governance layer that
adds milliseconds is one that gets removed under load, by the same person who installed
it.

**Delivery.** A question that does not reach a person is the single highest leverage gap.
Recorded and routed is most of the work and none of the value. Until an approval arrives
where somebody already works, every phase above six is discounted.

## Four things that never ship

These matter as much as the sequence, because each is where a product like this quietly
becomes a worse product with a larger surface.

- **Doing the work.** No step writes the code or issues the refund. The moment it
  executes, it competes with every agent framework instead of governing them.
- **Another assistant.** The value is a shared operational reality other systems read. A
  chat box is the interface, never the product.
- **A copy of the business.** It understands and points. Becoming the system of record
  for everything is a five year migration nobody agreed to.
- **Silent automation.** Nothing acts without an accountable identity and a record. An
  unattributable action is exactly what this category will be judged on.
