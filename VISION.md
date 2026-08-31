# The Memnox build sequence

The architecture this project is built toward. `ARCHITECTURE.md` describes what the
runtime is today; this describes the intent, across the open runtime and the cloud
control plane. Where the two disagree, this is the intent and `ARCHITECTURE.md` is the
state.

Eleven phases. Each answers one question, and none can answer its question before the
one above it has answered theirs. Cite a phase by number (`§03` for observe and learn,
`§08` for execution) when a change is answering to it.

> Given this person, this task, this context, this agent, these tools and this moment:
> should this action happen? Everything in the product exists to make that one question
> answerable.

---

## Three layers, and only one of them is a moat

Runtime enforcement is commoditising: the large vendors ship open source policy engines,
identity, isolation and kill switches. Agent discovery and continuous evidence are
commoditising from the other side, out of the compliance tools. **The space between them
is not.**

| Layer | The question | Alone it is |
|---|---|---|
| Memory | what is known, who owns it, what was decided, and why | a search product, and a crowded one |
| Authority | who this is, what it may know, what ceiling it holds, at which level | an access control product the platforms will ship |
| Execution | given all of that and a real intercepted action, does this one proceed | **the moat** — unbuildable holding only one of the other two |

**What this rules out:** charging for the enforcement primitive. Give the engine away
and sell the organizational layer around it.

**What it rules in:** every paid feature has to need the graph, the fleet, or another
person. If a capability works on one laptop with no account, it belongs in the open half.

**The sentence to sell on:** know every agent, know what it knows, know who it acts for,
control what it can do.

## The product ships no fictional agent

One decision sits under every screen in the open half: **the demo is the reader's own
machine**. No sample workspace, no seeded assistant, no simulated tool call, no staged
attack. The agents are the ones they already run.

It forces three things: every screen has to be honest when empty, discovery has to be
genuinely good, and every number on screen has to be derived. It forbids three: no
staged attack as the default demo, no estimated loss, no comparison score.

## The two minutes

At minute zero there is exactly one aggregate a machine can earn without traffic and
without an account: **what on this machine is already able to act**. Everything else at
that timestamp is a promise.

| | |
|---|---|
| 0:00 | `npx memnox` runs with no account, no key, no network. **The single most important decision in the plan**; phases 00 to 03 all follow from it. |
| 0:20 | Discovery names the workforce and its reach, read off the disk rather than earned over a day |
| 0:45 | `memnox doctor` ranks it into findings, each with the one change that closes it |
| 1:10 | `memnox harden` closes most of them, every step individually revertible and printing its undo |
| 1:30 | They go back to their actual task. Memnox is invisible for every ordinary action. |
| 1:50 | The first refusal redirects, the work still lands, and `memnox why` explains it in five lines |

**Secrets are fingerprinted, never stored.** Finding a credential requires reading the
file it lives in; the value never leaves the process. A shareable report carrying the
shape of somebody's SSH key would be the worst bug this product could ship.

## Where Memnox can actually stand

A verdict only exists if something has to ask for it, and **most real agents will never
voluntarily call an evaluate function**. Each product has a different seam, some have
none in process, and the plan names them one by one.

| Agent | Seam Memnox can hold | Blind to |
|---|---|---|
| Claude Code | tool hooks, MCP proxy, shell wrapper, git credential helper, egress | the model's reasoning |
| Cursor, Cline, Roo | MCP proxy, terminal, filesystem, egress | in-editor edits |
| Codex CLI | shell, filesystem, git, plus the credentials it was handed | provider-side execution |
| Copilot coding agent | issue assignment, PR gate, required checks, Actions boundary | everything before the PR |
| Devin, OpenHands | network egress, brokered credentials, the systems it reaches | the whole interior |
| Connector agents | MCP if it speaks it, otherwise only the credential and its scope | everything the vendor does |
| Any MCP client | the proxy, every tool call and every tool result | little — the best seam there is |

**MCP is the flagship seam.** It is the one place that is provider neutral, already in
the developer's config, and carries both the request and the result. Build it first and
best. **The seam that always exists** is the credential and the network: an agent that
cannot be wrapped can still be starved.

---

## The spine

| | Phase | The question it answers | Owns |
|---|---|---|---|
| | **Local. No account, no cloud, no network. The open runtime.** | | |
| 00 | The machine | What can act here, and what can it reach? | agent, surface, reachability, finding, harden step |
| 01 | The one call | What does a verdict look like, and how is it explained? | decision, explanation, policy bundle |
| 02 | Interception | How does the verdict reach an agent that never asked? | seam, MCP proxy, capability, lease |
| 03 | Observe and learn | What did they actually do, and what did they never need? | local ledger, frame, usage, lineage, proposal |
| | **The account arrives here, and only because a second person does.** | | |
| 04 | Census and scope | How many agents are there, who does each act for, who owns none? | org, member, workspace, subject, role, census entry |
| 05 | Govern | Which actions should be refused, agreed by more than one person? | policy, proposal, simulation |
| 06 | Authority | Who is asked, and who can stop it? | approval, delegation, grant, containment |
| 07 | The graph | How does the company know who answers for what? | node, edge, evidence, source, state fact |
| 08 | Execution | How does work move without anybody chasing it? | workflow, run, step, briefing |
| 09 | Operate | What did it cost, what is covered, what can we prove? | cost event, coverage, incident, export |
| 10 | Autonomy | Can this company safely give its agents more authority? | readiness, level, synthesis, detector |

---

## §00 The machine

The whole first act happens on one laptop with no account.

**Discover.** Read what is on disk: agent config, MCP manifests, editor settings, shell
profiles, CI workflow files, container sockets, cloud credential chains. Identify the
**kind, not the instance** — Claude Code on four machines is one agent kind, or the
roster is noise by week two. Enumerate MCP by listing tools over the protocol, and take
each tool's effect from its own annotation where one exists, inferring with a **stated
method** where it does not.

**Map the reach.** Counts and names, not percentages. **Reachability is transitive**: an
agent that can run a shell reaches everything the shell can, and stating that is most of
the value.

**Doctor.** Findings ranked by consequence, each naming the agent, the resource, the
evidence and the single change that closes it. The score decomposes or it does not
exist: it grants nothing, changes no permission, and is never a rank against anybody
else. No estimated loss, ever.

**Harden.** Propose, apply, revert. Every step prints its undo before it runs. Nothing
lands in their repository. Default to advise on anything ambiguous.

**Detectors are the maintenance burden.** Every one depends on somebody else's
undocumented config format; treat them as a versioned, separately releasable set, or a
single upstream rename silently empties the discovery screen.

*Fails when:* harden is not reversible per step.

## §01 The one call

The atom is a single function answering whether an action may proceed.

**Three effects, not two.** `allow`, `withhold`, `escalate`. The third keeps a governed
system from being a wall.

**An alternative wherever one exists.** A refusal that names the permitted path gets
taken, and a coding agent will take it without being asked twice. The `alternative` is
**resolved from the rule, not invented**.

**In process, on cached rules.** No network on the hot path, and a p99 under a
millisecond, which rules out a model inside `evaluate` permanently.

**Intent is declared, never inferred.** A session declares a task and the scope it
implies: these paths, this repository, this environment. **Scope is compared, not
judged** — out of scope is a fact a rule matches on, exactly like an environment. The
ambiguous middle escalates to a person rather than to a classifier. An undeclared
dimension is undeclared, never a guess.

**Untrusted context is stripped of instruction authority before matching.** Data cannot
become authority because an agent read it. A type, not a classifier: a detector can be
wrong; a type cannot be talked around.

**`shadowEffect` is the hinge of the whole plan.** Phase 03 has nothing to report and
phase 05 nothing to simulate unless observe mode still computes the real verdict and
stores it beside the permissive one.

**Why, in five lines.** Source, resource, authority, rule, outcome — built from the
match and stored beside the decision, so it reads the same a year later. An explanation
produced after the fact by a model is a plausible story about a decision, which is worse
than none.

## §02 Interception

A verdict nobody is obliged to ask for is advice.

**The MCP proxy, first and best.** One proxy governs Claude Desktop, Cursor and VS Code
at once. **Both directions**: the call on the way out and the result on the way back,
which is the only place a tool result can be caught trying to become an instruction.
Tool-level policy, not server-level. Install by rewriting their client config,
reversibly, with the original kept.

**The other seams**, one per agent kind, named and tested. Local, never a cloud round
trip. **Degradation is declared**: each seam states what it cannot see, because a
governed agent with an unwatched side channel is worse than an ungoverned one. Turn on
one at a time.

**Capabilities, not keys.** Nothing long lived is handed to an agent. The broker
exchanges a request for a lease scoped to one operation, one resource and a few minutes.
Ask by operation, not by secret. **Every lease is a decision.** Expiry belongs to the
issuer, never to the agent's good behaviour.

**Egress**: destination and payload both. Cheap and certain checks only — credential
shapes, known fingerprints, marked fields. Name the field in the refusal, and never
silently strip.

**Kill and panic live here.** Kill is: revoke leases, close seams, cancel pending calls
for one agent. Panic raises every seam to enforce and denies capability issuance, with a
reason, an author and a restore path. Neither is a demo feature.

## §03 Observe and learn

Watch for a day, then say what nobody could have said before: not only what the agents
did, but **what they never needed**.

**The local ledger.** Every verdict on disk, chained, the developer's own. **Arguments
hashed, results summarised** — a ledger that stores what an agent read becomes the thing
worth stealing. Retention is a setting with a default.

**The flight recorder.** Intent, context retrieved and its trust, capability issued, tool
called, result, side effects. One session, one timeline. Full fidelity on anything
withheld or escalated, sampled on the allowed majority. **The counterfactual is computed,
not imagined**: derived from the attempt actually made and from nothing else.

**Lineage.** Who caused this — a person, through a tool, through an agent, through a
repository, through a pipeline, to a system. Propagate where possible, stitch where not,
and **every hop states its method and confidence**. An inferred hop pretending to be a
propagated one is worse than a gap.

**Learn.** Usage against grant. **Unused is the finding.** Propose least privilege as a
real policy file in the format a person writes, diffed against what is in force. **Say
the window and the coverage** on the proposal itself, where they cannot be dropped in
the retelling.

*The line that sells the project:* you granted this agent everything and it used twenty
seven percent of it.

*Fails when:* the ledger stores payloads.

## §04 Census and scope

The account arrives here, and only because a second person does.

**The census is the paid product's own opening.** Four independent sources — runtime
enrolment, provider APIs, pipeline configuration, vendor products. Every count links to
its evidence. **Name the ungovernable**, and **the gap is the finding**: what they were
tracking against what is there.

**Identity in three parts.** The **kind** is the product. The **role** is the job —
policy is written about the role, because a rule about Claude Code governs a product and
will be wrong the moment the company adopts another one. The **principal** is the person
it acts for. All three or it is not enrolled.

**One subject table.** Humans and agents differ in how they authenticate and in nothing
else. **Governability is a field, not a filter**, or the dashboard quietly reports only
the agents that were easy.

**Ids are the seam.** Local ids are globally unique from the first run, so promotion is
an update rather than a re-registration. **Nothing is uploaded silently.**

**Drift between machines is the finding.** One laptop with the proxy off is the story,
not the thirty-nine with it on.

*Fails when:* enrolment uploads by default.

## §05 Govern

A rule written, tested, approved by somebody other than its author, and put in force
across a fleet.

**Rules take cases** — a ceiling that allows, a band that needs a manager, a band that
needs two, a band that refuses, as one ordered list. Splitting that across four policies
means four things to keep consistent.

**Policies have unit tests**, kept beside the rule and run in the customer's pipeline.
The test file is the specification a non-engineer can read.

**Simulation replays thirty days using the runtime's own compiled evaluator.** A second
implementation would drift within weeks, and the simulation would then be fiction.
**Report both directions**: what it would newly refuse, and what it would newly permit.

**Blast radius names who is affected** — agents, installs, environments, owners,
resolved rather than counted — and is attached to the proposal, so the approver reads the
consequence and not the syntax.

**Proposed, not added.** Versions, diffs and rollback; every change is a new version
pointing back. Predicates compile to a small closed expression form, never to code
evaluated at runtime.

**Time travel is a consequence, not a feature.** If policies, grants and capabilities all
carry validity intervals, "what would have happened last Tuesday" is a query.

*Fails when:* simulation is a second evaluator in the cloud.

## §06 Authority

**Escalate names a target**, resolved from the organization rather than typed into the
rule. **A room, not an inbox** — delivery is the highest-leverage unbuilt thing, and
every phase above this one is discounted until a question reaches a person where they
already work. **Deadlines are real**, with a defined outcome, and the safe one is the
default.

**Delegation is an object**: issuer, delegate, authority, scope, expiry, and whether it
can be passed on. **An agent cannot delegate what it does not hold**, checked at issue
and again at use, so a chain can only narrow. Agent-to-agent is the same check, which
makes multi-agent systems governable rather than a new category.

**Stopping things.** Kill one agent everywhere, in one recorded action. Quarantine is
read-only with no capability issuance, which keeps an agent debuggable instead of dead.
**Containment across a fleet is partial by nature** — the action records which installs
it reached and **which it did not**. A kill reporting success while one machine is
offline is the worst possible lie.

*Fails when:* the timeout default is allow.

## §07 The graph

Everything so far can be configured. This is the part that cannot.

**Ownership as a query.** For any object and action, who answers — resolved rather than
configured, returning the chain rather than a name.

**State, not only structure.** A deployment freeze, an open incident, a change window, a
contract clause. **State is a policy input**: a merge refused because incident 928 is
open and the freeze is active is organizational intelligence enforcing an action, which
is the whole thesis in one verdict. Facts are small, versioned, and **carry a mandatory
expiry** — a freeze that outlives its incident is worse than no freeze, because the next
one gets ignored. They ride inside the bundle, so the evaluator still decides locally.

**The memory firewall.** The same store answers differently by role. What an agent may
know is governed by the same objects as what it may do. **Every read is filtered in the
query** — filtering after retrieval means the material was already in a process answering
to a different identity.

**Refuse rather than guess**, and carry a withheld count so a caller is told there was
more it could not see. **Edges carry validFrom and validTo** rather than being deleted.

**Do not start with a graph database.** Ownership resolution is two to four hops.

*Fails when:* scoping is a filter over the response.

## §08 Execution

**The invariant:** every route to a delegation passes a decision or an approval.
Validation walks backward from every delegate node to the trigger; if any path reaches
the trigger without crossing a gate, the save is refused. The console mirrors it while
drawing; the server enforces it regardless.

**Dispatch carries four things:** the objective, the context with its trust levels, the
constraints, and a capability rather than a key. **Context trust survives the handoff**,
or the injection path §01 closed reopens at the boundary. **The correlation id travels
too**, so a delegated run is a lineage hop rather than an unexplained new actor.

**Durable and resumable.** The workflow version is pinned at run start. A step row is
written as pending before anything happens. Execution is keyed by run, node and attempt.
**Memnox never does the work.**

*Fails when:* the engine keeps run state in process.

## §09 Operate

**Coverage, defined:** distinct actions governed over distinct actions seen, weighted by
risk, times seam coverage, times install coverage. A read loop otherwise shows
ninety-nine percent while every irreversible action in the company is ungoverned.

**Cost** per workspace, per agent, per model. **Ceilings that bite**, expressed as a
policy input rather than a separate switch, so a breach produces a verdict with a reason.
Keys are write-only across the seam.

**Evidence** an auditor accepts, continuous rather than assembled, with the chain
travelling with it so it verifies outside the product.

**Drift needs a cause, not an alarm.** A widened agent is usually somebody installing a
tool. The finding names the cause from §04's supply chain events, so the common case
reads as a change to approve and the rare case stands out.

**Chains are invisible one action at a time.** Each hop is individually permitted, so no
local evaluator will ever see one. It takes the fleet ledger and the lineage joined
across systems — the clearest technical argument for why the paid half exists.

**Detector discipline:** every detector is scored against the ledger before it acts
alone. Detection proposes containment; a person confirms it.

*Fails when:* reporting describes the product rather than the organization.

## §10 Autonomy

Every phase before this restricts. This one is why a company keeps paying.

**Levels, not scores.** Observe, suggest, act reversibly, act within bounds, act
autonomously, hold delegated authority. **A level is a policy bundle**, not a number in a
field. A scalar that silently widens permission is unauditable and impossible to explain
to a regulator.

**Down is automatic, up is not.** An incident demotes on its own; nothing promotes
without a person. **Trust never widens authority on its own** — it is evidence in front
of a person, and the moment it becomes an automatic grant the product has removed the
accountable human it sells.

**Readiness is a checklist, not a score**, and **every item is a query** against
something already stored, so nobody can tick one. An item nothing answers yet is unknown,
which is not a pass.

**Least privilege and synthesis are the same idea at two scales:** unused capability
narrows a grant locally, repeated approval widens a rule organizationally. Nothing gets a
private path into policy.

**Two kinds of number, kept apart.** Actions, interventions, retries and spend are
**measured**. Hours saved and value delivered are **modelled** from a rate the customer
sets, and the result is labelled as theirs.

**The one measure:** approvals removed without a rise in incidents.

**Standing limit:** self-proposing is the ceiling in perpetuity. There is no version of
this product that enacts its own rules.

---

## Open source and cloud

**Everything one person needs to govern the agents on their own machine is open and
works with no account.** Anything that only means something across more than one person
is the cloud. The transition is not a paywall; it is the moment a second person arrives,
which is exactly where §04 sits.

| Capability | Open runtime | Cloud |
|---|---|---|
| Discovery, map, doctor, harden | yes | yes |
| Decision object, evaluator, why | yes | yes |
| MCP proxy, seams, broker, egress | yes | yes |
| Local ledger, replay, lineage | yes | yes |
| Observe, learn, least privilege | yes | yes |
| Kill, quarantine, panic | local | fleet |
| Chained ledger across machines | local only | yes |
| Proposal, review, fleet distribution | files only | yes |
| Approvals into a room, review queue | terminal only | yes |
| Organizational graph and ask | — | yes |
| Fleet view, coverage, spend, evidence | — | yes |
| Detectors, synthesis, readiness, levels | — | yes |
| Census of agents nobody enrolled | — | yes |
| Role and principal identity | kind only | yes |
| Organizational state as a policy input | — | yes |
| Cross-agent chain detection | — | yes |
| Compliance evidence, SSO, SIEM | — | yes |

---

## What we would not build

Each is a place where the product would trade something it can prove for something it
cannot.

- **An estimated loss figure.** Nobody can derive it, and publishing one tells a security
  reader the rest is marketing.
- **A risk score that grants.** The moment a number silently widens or narrows a
  permission it is unauditable. Authority belongs in a named level a person granted.
- **Irreversible hardening.** Every automatic change prints its undo before it runs.
- **Storing what it read.** Secret values, tool arguments and results are fingerprinted
  or summarised, never kept.
- **A staged attack as the demo.** As a first-run experience it is a fixture, and this
  product's whole claim is that it uses none.
- **Honeypots and decoys.** A false-positive problem with no buyer, and it invites an
  agent to do something it would not otherwise have done.
- **A model in the enforcement path.** Types and cheap certain checks in the path, models
  in the ledger.
- **Agent negotiation and certification.** Delegation with narrowing scope already covers
  every case anyone can name.
- **Risk exposure in currency.** The census reports counts, reach and owners, all of
  which are true and all of which are more alarming.
- **Value delivered, in our voice.** Report measured counts, take the rate from the
  customer, label the result as theirs.
- **Seventy tabs.** The product answers seven questions: who is it, what does it know,
  what may it do, why, who authorised it, should it proceed, what happened.

## Why this order

| | |
|---|---|
| **Local first** | No account until a second person needs one. |
| **Discovery** | It is the only honest aggregate at minute zero. |
| **Interception** | A verdict nobody is obliged to ask for is advice. |
| **Redirect** | A refusal names an alternative, or the agent abandons the task. |
| **Intent** | Declared, never inferred in the path. |
| **Give away** | The enforcement primitive is free; the organization is not. |
| **Ledger** | The record precedes the rule. A policy editor opened before there is traffic is a blank form. |
| **Ask** | Approvals precede workflows. |
| **Latency** | The hot path never waits on the control plane, and never on a model. |
| **Delivery** | A question that does not reach a person is the highest-leverage gap. |

## Four things that never ship

- **Doing the work.** No step writes the code or issues the refund.
- **Another assistant.** A chat box is the interface, never the product.
- **A copy of the business.** It understands and points.
- **Silent automation.** Nothing acts without an accountable identity and a record.
