# The Memnox build sequence

The architecture this project is built toward, across the open runtime and the cloud
control plane. `ARCHITECTURE.md` describes what the runtime is today; this describes the
intent. Where the two disagree, this is the intent and `ARCHITECTURE.md` is the state.

Ten phases. Each answers one question, and none can answer its question before the one
above it has answered theirs. Cite a phase by number (`§03` for observation, `§09` for
policy candidates) when a change is answering to it.

Shapes are proposals. Every claim in here about another product is a claim to verify
against that product's documentation before anything is built on it.

---

## Memnox answers four questions

Everything else is later.

1. **What can my agents access?**
2. **What are they actually doing?**
3. **What does my organization say they are allowed to do?**
4. **Can Memnox stop them when those two things disagree?**

A junior engineer should be able to hold the whole product in one shape:

```
Connect your agents. Memnox discovers agents, MCP servers, tools,
files, secrets, repositories and organizational instructions.

   OBSERVE
      |
   UNDERSTAND
      |
   PROTECT
      |
   EXPLAIN
```

**What the first version is not.** Not AI governance as a category pitch. Not forty
dashboards, not enterprise compliance, not elaborate role hierarchies, not autonomous
policy generation, not a trust score, not a sprawling agent graph, not multi agent
simulation. Every one of those is downstream of the four questions and none of them
answers one.

## Three kinds of truth

The single most important architectural decision is that Memnox holds three different
kinds of truth and never confuses one for another. Most of the product's value comes from
putting them next to each other; most of the ways it could go wrong come from collapsing
them.

**A. Technical truth: what can the machine actually do?**

Read from agent configuration (Claude Code, Codex, OpenCode, Cursor, OpenClaw, Hermes),
MCP manifests, filesystem permissions, environment variables, Docker, Git, SSH, cloud
credential chains and running processes. This is **observed capability**. It is true the
moment it is read, and it is the only honest aggregate at minute zero.

**B. Organizational truth: what does the organization say should happen?**

Read from `CLAUDE.md`, `AGENTS.md`, `.cursor/rules`, READMEs, runbooks, architecture
decisions, incident documents, security policies, `CODEOWNERS`, and then, in the cloud
half, from Slack, GitHub issues and pull requests, Linear, Jira, Notion, Google Docs and
Confluence. This is **organizational intent**. It is never automatically true, it is
always somebody's statement, and it always has an author and a date.

**C. Runtime truth: what actually happened?**

Read from agent tool calls, MCP calls, PreToolUse hooks, process execution, Git and
GitHub events, CI and CD, cloud audit logs, gateway events and Memnox's own decisions.
This is **execution evidence**. It is the only one of the three that cannot be argued
with.

The product is the join. Capability alone is a scanner, intent alone is a search tool,
evidence alone is a log. Together they answer the fourth question.

## An organizational instruction is evidence, not a policy

This is the line the whole product rests on.

Suppose Slack contains: *"Don't deploy payments to production until INC-1842 is
resolved."* Memnox does **not** turn that into `deny production deployment`. It records:

```
ORGANIZATIONAL SIGNAL

Source              Slack, #platform, message from Sarah, 28 Aug
Message             [the actual message, quoted]
Claim               Payments production deployment is currently restricted
Applies to          payments-service
Condition           Until INC-1842 is resolved
Confidence          High
Expires             Unknown
Needs confirmation  Yes
```

Then, and only then, it asks a person: *I found an organizational instruction that
appears to restrict production deployment. Turn it into an enforceable policy?*

```
Slack -> Evidence -> Candidate rule -> Human confirmation -> Policy -> Enforcement
```

**Why the extra step is the product.** A system that silently promotes a chat message to
a security control is unauditable and will be switched off the first time it is wrong. A
system that shows its working, names the sentence a human wrote, and asks, earns the
right to enforce. The confirmation step is not friction to be optimised away later. It is
the reason anybody trusts the enforcement.

## The source hierarchy

Not every source carries the same authority, and a random message must never outrank a
written policy. Five levels, highest first.

| | Level | Sources | Authority |
|---|---|---|---|
| 1 | Explicit policy | security policy, managed Memnox policy, admin configuration | Decides |
| 2 | Repository rules | `CLAUDE.md`, `AGENTS.md`, `.cursor/rules`, README, deployment config, `CODEOWNERS` | Strong, scoped to the repository |
| 3 | System configuration | MCP permissions, agent permissions, cloud IAM, GitHub permissions, branch protection | Strong, and observable rather than stated |
| 4 | Operational sources | Jira, Linear, GitHub issues, incident systems, runbooks | Suggests, with a condition and a lifetime |
| 5 | Communication | Slack, Discord, Teams, email | Suggests only, always needs confirmation |

Slack is extraordinarily useful and it is level five. A level five source can raise a
candidate; it can never be the sole basis of an enforced rule.

## Policy provenance

Every policy answers where it came from. A rule whose origin cannot be shown is a rule
somebody will delete rather than argue with.

```
POLICY   Production deployment

DENY unless approved by Platform Engineering

SOURCE
  GitHub    .github/CODEOWNERS
  GitHub    branch protection on main
  Runbook   production-deployment.md
  Slack     #platform, message from Sarah, 28 Aug

Confidence      98%
Last verified   today
```

So a policy is stored as evidence plus a decision, never as a bare rule:

```
id            production-db-write
effect        escalate
scope         payments-service
condition     environment = production
evidence      repository-rule, github-codeowners, jira-PAY-821, slack-message-9281
created_by    a named person
created_at    a timestamp
expires       a timestamp or a resolved condition
confidence    high
```

## Three effects, and the words the interface uses

The decision object has exactly three effects and there is no fourth: `allow`, `withhold`,
`escalate`. The interface says **ALLOW**, **DENY** and **ASK**, because those are the
words a developer already thinks in. `escalate` and ASK are the same thing, and it is the
one that keeps a governed system from being a wall.

A refusal always names an alternative, resolved from the rule that withheld and never
invented. An agent told only no abandons the task and the developer blames the tool. An
agent told what to use instead finishes the work.

## Memnox uses each agent's native control

Memnox does not build a parallel enforcement mechanism per agent and it does not pretend
every runtime works the same way. It compiles one intent into whatever control that agent
already exposes, and where an agent exposes none, it says so rather than implying cover it
does not have.

| Runtime | The control to compile into |
|---|---|
| Claude Code | MCP tool permissions and the PreToolUse hook, which is deterministic and runs before the tool does |
| Hermes | per server tool include and exclude lists, and untrusted server behaviour for write capable tools |
| OpenClaw | its own gateway, operator and tool authorization model, alongside its security audit |
| Codex, Cursor, OpenCode | whatever each exposes, named honestly, including nothing |

**The philosophy.** OpenClaw can already tell you about OpenClaw. Memnox tells you about
OpenClaw and Claude Code and Codex and Cursor and your organizational rules, in one shape,
with one set of words. Normalising the control surfaces and adding the organizational
layer is the contribution. Replacing those control surfaces is not.

## The product ships no fictional agent

One decision sits under every screen in the open half: **the demo is the reader's own
machine**. No sample workspace, no seeded assistant, no simulated tool call, no staged
attack. The agents are the ones they already run, the repositories are theirs, the
credentials are the ones in their home directory right now.

**What it forces.** Every screen has to be honest when empty. If there is one MCP server,
it says one. The inventory is never fabricated and no count is ever rounded up into
something more alarming. Three write capable tools is *"3 write-capable tools are
available to your agent"*, not *"your system is critically vulnerable"*. The moment a
security reader catches one overstated number, the rest of the output is marketing to
them, and they are the buyer.

---

## The spine

The Owns column names the store or object each phase introduces, which is the real test
of whether it is a phase or a screen.

| | Phase | The question it answers | Owns |
|---|---|---|---|
| | **Local. No account, no cloud, no network. This is the open runtime.** | | |
| 01 | Discovery | What can act here, and what can it reach? | agent, MCP server, tool, surface, finding |
| 02 | Evidence | What is the one shape everything is recorded in? | evidence, source, claim, confidence, the normalized model |
| 03 | Observation | What are the agents actually doing? | seam, hook, frame, local ledger, lineage |
| 04 | Explain | What can this agent do, and why was that blocked? | deterministic answers over 01 to 03 |
| 05 | Protect | Which actions need a person, and how is that enforced? | policy, rule, effect, the compiler into native controls |
| 06 | Watch | What changed since yesterday? | drift, change event, conflict, containment |
| 07 | Repository evidence | What do the code and the configuration already say? | repository rule, ownership, branch state |
| | **The account arrives here, and only because somebody else's systems do.** | | |
| 08 | Organizational evidence | What did the organization say, and where? | signal, channel scope, author, condition, expiry |
| 09 | Policy candidates | Which signals should become enforceable rules? | candidate, provenance, confirmation, expiry, conflict |
| 10 | Cloud | Who can do what across the whole company, and why did they? | fleet, identity, ownership, approvals, the decision graph |

---

## §01 Discovery

`npx memnox scan` is the first experience, not `init`. The user runs one command and
Memnox tells them something true about their own machine.

```
MEMNOX   Scanning your AI environment...

  Claude Code detected
  Hermes detected

  MCP             GitHub, Slack, Linear, Filesystem
  Configuration   ~/.claude, ~/.hermes, project instructions
  Repository      Git, GitHub remote

Found   2 agents   4 MCP servers   31 MCP tools
        3 instruction sources   2 repositories
```

**Tasks.**

- **Detect the agents that are actually installed.** Claude Code, Codex, OpenCode,
  Cursor, OpenClaw, Hermes. The acceptance test is that `memnox scan` returns only agents
  that exist on this machine.
- **Enumerate MCP properly.** Every server, its transport, its command or URL, and every
  tool, classified as read, write or destructive. No client shows this anywhere, which is
  why it is the first thing worth showing.
- **Inspect a single agent.** `memnox agents inspect claude-code` shows that agent's real
  configuration and real capabilities.
- **Never store a secret value.** A path, a kind and a fingerprint. The value stays in the
  process that read it. A report carrying the shape of somebody's SSH key is the worst bug
  this product could ship.
- **Every harden step states its inverse**, and prints the undo before it runs.

**The second thing to show is the one they did not know.** Having read the real MCP
configuration, name the write capable tools by name: `refund_payment`, `send_message`,
`delete_customer`. That is a fact about their setup they did not have five seconds ago,
and it is the reason they keep reading.

## §02 Evidence

One normalized model, defined once, that every later phase writes into. Getting this
wrong is the mistake that is expensive in month six.

**The objects.** Agent, MCPServer, Tool, Resource, Identity, Source, Evidence, Action,
Decision, Policy.

**Evidence carries** `source_type`, `source_id`, `content`, `timestamp`, `author`,
`scope`, `confidence` and `hash`. The author and the timestamp are not optional: an
instruction with no author is a rumour, and one with no date cannot expire.

Technical truth, organizational truth and runtime truth all land in this shape, tagged by
which they are. Nothing downstream has to know where a fact came from to store it, and
everything downstream can tell.

## §03 Observation

A verdict nobody is obliged to ask for is advice. Most agents will never call an evaluator
voluntarily, so the seam is the product.

**Start with Claude Code**, because its hook system is a deterministic integration surface
that runs before a tool executes. `memnox claude install` configures the hooks; every
event becomes a frame:

```
{ "agent": "...", "tool": "...", "input": "...", "timestamp": "...", "decision": "..." }
```

**Then the other seams.** The MCP proxy checks both directions, the call on the way out
and the result on the way back. A tool result is wrapped as an untrusted context block
whatever it says, and instruction shaped content in a result is recorded and framed rather
than removed. Untrusted context can never become authority; that is a type, set by whoever
supplied the block, not a detector's guess.

**The ledger is local and it is theirs.** Their machine, their record, no account to hold
it. Arguments and results are fingerprinted or summarised, never kept whole. A ledger
holding everything the agents read, sitting on a laptop, is the product becoming the
vulnerability.

## §04 Explain

Deterministic answers first. No model on this path.

```
memnox explain "what can Claude Code do?"

CLAUDE CODE

  FILES    read, write
  SHELL    bash

  MCP      github    list issues, create issue
           slack     search, send message
           database  query

  Potentially sensitive
           slack.send_message
           database.write
```

**Structured questions are answered from structured data.** What MCP servers do I have,
what tools can this agent reach, what is write capable. **Policy questions are answered
from policy and evidence.** Why was this blocked. A model is used only for things that are
genuinely summarisation, such as what happened today, and never for a verdict and never
for an explanation of one.

**The explanation is built from the match.** It reads the decision, the request and the
scope comparison. An explanation a model wrote afterwards is a plausible story about a
decision, which is worse than none.

Every decision shows what, why, source and decision:

```
BLOCKED

Agent    Claude Code
Tool     database.write
Target   production

Why
  1  This agent has no production write policy.
  2  Repository rules require production changes to go through a PR.
  3  The current GitHub branch is not approved.

Sources  repository policy, GitHub branch state, Memnox policy
Decision DENY
```

## §05 Protect

Memnox does not invent a policy. It proposes one, from an observed capability, with a
reason.

```
PROTECTION SUGGESTION

Stripe MCP, write capability detected: refund_payment

Require approval before this action?          [ Protect ]

Reason: this action changes external financial state.
```

**The policy language stays small.** A rule is a tool, a scope and one of three effects.
No expression language yet.

```
rule:
  tool: mcp__stripe__refund_payment
  effect: escalate
```

**Then it compiles into the native control.** Claude Code's hooks and MCP permissions.
Hermes tool filtering and untrusted server trust. OpenClaw's gateway authorization. The
same intent, expressed in the mechanism each runtime already enforces.

**The default shape for a newly discovered server** is read automatic, write approval
required, destructive denied, offered as a suggestion and never applied silently.

**The decision path is deterministic**: no model, no network, no clock as an input to a
verdict, no randomness, and a p99 under a millisecond in process. A governance layer that
adds noticeable latency is one that gets removed under load, by the same person who
installed it.

## §06 Watch

The reason to keep Memnox running.

```
MEMNOX WATCHING

  Claude Code   *      Hermes   *      OpenClaw   *
  MCP  4               Policies 7

Watching for new tools, new MCP servers, sensitive actions,
policy conflicts and configuration drift.
```

Then something changes:

```
NEW MCP SERVER

Detected  stripe
Added     14 tools, 5 of them write capable
Policy    none exists                            [ Review ]
```

**Drift is the same idea over time**, and it is more useful than any score:

```
MEMNOX DRIFT

Your agent's reachable systems changed.

Yesterday  GitHub
Today      GitHub, Postgres

New capability   database access
Organizational policy   none found            [ Review ]
```

**Watch for exactly this list** and nothing else yet: a new MCP server, a new tool, a new
credential, a new repository, a new capability, a new policy, a blocked action, a policy
conflict.

**Containment lives here too**, because safety controls behind a paywall are a bad look
and a worse argument. Kill, quarantine and panic work locally with no account, and
containment always names what it did not reach. A kill reporting success while one machine
is asleep is the worst possible lie.

## §07 Repository evidence

The first organizational truth, and it is already on disk or one authenticated call away
with the developer's own credentials.

**Read** README, `AGENTS.md`, `CLAUDE.md`, `.cursor/rules`, `CODEOWNERS`, branch
protection, pull requests, issues, branches and commits. **Then say something concrete:**

```
Your repository requires review before merge.
Source: CODEOWNERS, GitHub branch protection.
```

That is real evidence with a real citation, and it is the first time a Memnox policy is
grounded in something the organization actually wrote rather than in a default somebody
picked.

---

## §08 Organizational evidence

The account arrives here, because Slack and Jira are somebody else's systems and holding
another person's data is what a control plane is for.

**Do not ingest everything.** Start with selected channels, `#engineering`, `#platform`,
`#security`, `#incidents`, and search only for the vocabulary that carries operational
instructions: deploy, production, incident, security, database, credentials, approval, do
not, blocked, migration.

**Everything produced here is Evidence.** Never a policy, not once, not for a high
confidence match.

**Use existing connectors where they exist.** MCP, webhooks and vendor APIs. Memnox's job
is reasoning over evidence, not becoming a connector marketplace. The integration count is
not the moat and chasing it is how this scope kills the company.

## §09 Policy candidates

`memnox policy suggest` is the bridge between the open half and the cloud half.

```
I found a recurring organizational instruction.

Evidence
  GitHub  production deployment requires PR review
  Slack   "Don't deploy directly to prod"
  Jira    PAY-821 awaiting approval

Suggested policy   Production deployment -> require approval

[ Create policy ]
```

**Three things this phase owns beyond the suggestion itself.**

**Expiry.** A Slack message about an incident should not govern anything a year later.

```
POLICY EXPIRING

Production deployment restriction
Created from   Slack #platform, 14 days ago
Condition      "until the incident is resolved"
Incident       RESOLVED

Retire this policy?     [ Retire ]  [ Keep ]  [ Review ]
```

A rule that outlives its incident is worse than no rule, because the next one gets
ignored. This is organizational memory becoming operational, and it is the thing a static
policy engine cannot do.

**Conflict.** When sources disagree, say so rather than picking:

```
POLICY CONFLICT

Slack   deployment restricted
Jira    incident resolved
GitHub  deployment approved

Current enforcement   DENY
Recommended           review this policy before the next deployment
```

**Confirmation.** Nothing here enforces until a named person agreed to it, and the record
keeps who.

## §10 Cloud

The cloud is not the open runtime with a dashboard. It is the open runtime plus
organizational context plus control across more than one machine.

**The first cloud moment is not five hundred agents.** It is one action, refused with a
reason nobody could have assembled by hand:

```
Claude Code requested   deploy payments-service

ASK

Why
  GitHub  PR #821 requires platform approval
  Jira    PAY-821 is awaiting approval
  Slack   production deployment is paused until PAY-821 resolves

Current state   NOT AUTHORIZED

[ Approve ]  [ Deny ]  [ View evidence ]
```

**Monday morning is a change list, not a chart.**

```
Since Friday

  Claude Code   +1 MCP server
  OpenClaw      +2 tools
  GitHub        3 new repositories accessible
  Slack         1 new operational restriction detected
  Jira          2 incidents resolved
  Policies      1 expired, 2 need review
  Actions       3 blocked, 18 approved
```

**Fleet questions only the cloud can answer.**

```
memnox who --can "deploy production"

  Claude Code  yes   GitHub Actions plus deployment credentials
  OpenClaw     yes   deployment tool
  Codex        no    no production credential
  Cursor       no    no production credential
```

```
memnox context claude-code

  Repository            payments-api
  Instructions          CLAUDE.md, AGENTS.md
  Connected knowledge   GitHub, Linear
  Accessible MCP        GitHub, Slack
  Potentially sensitive customer-support channel, internal incidents
```

Which lets the cloud answer *why did the agent know about this incident?* with
`Slack -> MCP -> Claude Code -> conversation`. That joins data access, organizational
memory and agent execution, and it is the question nothing else in the category can answer.

**Call it "Why?" in the interface, not "Organizational Memory".** The user's question is
*why can't I do this*, and the answer comes from GitHub, Slack, Jira, docs, policies and
previous decisions. Naming the mechanism instead of the question loses people.

**What the cloud grows into**, once the first moment lands: identity and ownership,
approvals routed to where people already work, cross agent lineage, delegation chains that
only narrow, workflow gates, incidents, cost attribution, compliance evidence, and
eventually the autonomy question, which is *can this company safely give its agents more
authority*, answered as named levels a person granted rather than as a score.

---

## The moat is not the adapters

Anyone can copy a Claude adapter, an MCP scanner or an OpenClaw integration. What compounds
is what accumulates behind them:

```
organizational evidence + decision history + policy provenance
+ runtime actions + identity
```

Over time Memnox holds what the company said, what the company configured, what the agents
actually did, what humans approved, and what happened afterwards. That is a decision graph,
and it is not reproducible by a competitor who starts today.

## The line between open and cloud

Drawn on a principle, not on a feature count, or every quarter is an argument.
**Everything one person needs to govern the agents on their own machine is open and works
with no account.** Anything that only means something across more than one person, and
that needs somebody else's data to work, is the cloud.

| Capability | Open | Cloud |
|---|---|---|
| scan, discover, agents, mcp | yes | yes |
| observe, protect, explain, why, trace | yes | yes |
| watch, diff, drift | yes | yes |
| quarantine, panic, kill | local | fleet |
| local ledger and replay | yes | yes |
| repository evidence with your own credentials | yes | yes |
| Slack, Jira, Linear, Notion, Drive, Confluence | no | yes |
| GitHub organization, CI and CD, cloud infrastructure | no | yes |
| identity, ownership, fleet, approvals | no | yes |
| policy provenance across sources, conflict, expiry | candidates only | yes |
| cross agent lineage and chain detection | local only | yes |
| cost, compliance evidence, SSO, SIEM | no | yes |

**The competitive reason matters as much as the principle.** The enforcement primitive is
being given away by companies with more distribution. A policy engine behind a login is a
losing position within a year. Give away the engine, sell the organization around it.

## The loop

Not a dark pattern. Operational dependence.

```
Install
  -> discover something surprising
  -> protect it
  -> the agent keeps working normally
  -> Memnox blocks and explains one risky action
  -> the user trusts it
  -> Memnox notices a configuration change
  -> the user asks Why
  -> the organization connects Slack, GitHub and Jira
  -> policies become contextual
  -> Memnox is where you go to understand what the AI did
```

The fourth step is the one people skip. If protection breaks the agent's normal work, none
of the steps after it happen.

## The promise

Not *the cryptographic routing and state enforcement layer for billions of autonomous
agents*. That is a company vision, not a first sentence.

> **Know what your AI can do. Before it does it.**
>
> Connect Claude Code, Codex, Cursor, OpenCode, OpenClaw or Hermes. Memnox discovers
> their real tools and access, watches what they actually do, and protects sensitive
> actions using the controls each agent already supports.
>
> `npx memnox scan`
>
> No account. No cloud. No fake demo data.

And for the hosted half:

> **Give your AI more autonomy without losing control.**
>
> Memnox connects agent activity with the policies, decisions and context already living
> in your GitHub, Slack, Jira, Linear and internal documentation.

Which gives the progression the whole sequence is built to deliver:

```
OPEN     what can my agent do -> what is it doing -> protect it
CLOUD    what does our organization allow -> who authorized this
         -> why did the agent do it -> can we safely give it more autonomy
```

## The five things to build if only five

- **Show me what my agent can actually access.** `memnox scan`, on a real environment.
- **Protect the dangerous capabilities.** `memnox protect`, through native controls, never
  fake sandboxing.
- **Tell me why an action was blocked.** `memnox why`, over a real tool call and a real
  policy.
- **Tell me what changed.** `memnox diff`, over real configuration and runtime drift.
- **Tell me what my company actually says about this action.** `memnox explain "can this
  agent deploy payments?"`, answered from GitHub, Slack, Jira, docs, current configuration
  and previous decisions.

The fifth is where Memnox stops being an agent security tool.

---

## What we would not build

Each is a place where the product trades something it can prove for something it cannot.

- **A trust score.** A number that silently widens or narrows a permission is unauditable.
  Authority is a named level a person granted.
- **A model deciding, or explaining a decision.** Both put a model on the hot path of every
  action, and the first slow week is the week enforcement is switched off. Deterministic
  checks in the path, models in the ledger.
- **A model inferring intent.** A client declares its task; comparison is deterministic and
  an undeclared dimension is undeclared, not a guess.
- **An estimated loss, a currency exposure, or hours saved in our voice.** Publishing a
  modelled number tells a security reader the rest of the output is marketing. Report
  measured counts, take the rate from the customer, and label the result as theirs.
- **A staged attack, a seeded workspace, or any fixture.** The demo is the reader's own
  machine.
- **Irreversible hardening.** One over eager default breaking a build at midnight is the
  failure this product does not recover from.
- **Storing what it read.** Secret values, tool arguments and results are fingerprinted or
  summarised, never kept.
- **Honeypots, decoys and agent certification.** A research technique with a false positive
  problem and no buyer, and a certificate worth exactly what the issuer's reputation is
  worth.
- **A connector marketplace.** Use MCP, webhooks and existing connectors. Reasoning over
  evidence is the product; integration count is not the moat.
- **Seventy tabs.** The product answers four questions. A console that needs a tour has
  stopped answering them.

## Why this order

**Discovery first.** It is the only honest aggregate at minute zero. A count read off the
reader's own disk is true immediately; every other number has to be earned over a day.

**The model before the sources.** One evidence shape defined at phase two is why phases
seven, eight and nine can add sources without a rewrite.

**Observation before enforcement.** A verdict nobody is obliged to ask for is advice. The
seam is the product, and a plan that assumes cooperation governs only the agents it wrote
itself.

**Explanation before protection.** A block a user cannot interrogate is a block they will
disable. Building `why` before `protect` means the first refusal already has an answer.

**Native controls, not a new one.** Compiling into what each runtime already enforces is
what makes Memnox additive rather than another thing to install and trust.

**Evidence before policy.** A policy editor opened before there is traffic to write about
is a blank form, and the first user concludes the product is configuration.

**Repository before Slack.** Level two evidence needs no account and no permission from
anybody. Starting at level five would mean asking for a workspace token before proving
anything.

**Confirmation before enforcement.** The path from a chat message to an enforced rule
always goes through a person. Removing that step is the single change that would make this
product untrustworthy.

**Local before cloud.** No account until somebody else's systems are needed. The open
half's entire credibility is that nothing leaves the machine, and a plan that opens with
sign in has conceded that the runtime cannot stand alone.

## Four things that never ship

- **Doing the work.** No step writes the code or issues the refund. The moment it executes,
  it competes with every agent framework instead of governing them.
- **Another assistant.** The value is a shared operational reality other systems read. A
  chat box is an interface, never the product.
- **A copy of the business.** It understands and points. Becoming the system of record for
  everything is a five year migration nobody agreed to.
- **Silent automation.** Nothing acts without an accountable identity and a record. An
  unattributable action is exactly what this category will be judged on.
