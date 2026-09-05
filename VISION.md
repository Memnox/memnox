# Memnox — Complete User Pain Brainstorm

> **Memnox connects three realities:**
>
> **What an AI agent can do → What it actually does → What humans intended it to do.**

---

## Table of Contents

1. [The Core Problem](#1-the-core-problem)
2. [User Pain Brainstorm](#2-user-pain-brainstorm)
3. [The Pains I Would Prioritize](#3-the-pains-i-would-prioritize)
4. [Three Layers of Pain](#4-three-layers-of-pain)
5. [The 10 WOWs I'd Actually Build](#5-the-10-wows-id-actually-build)
6. [The Ultimate Memnox Loop](#6-the-ultimate-memnox-loop)
7. [The Product Evolution](#7-the-product-evolution)
8. [The Core Memnox Model](#8-the-core-memnox-model)
9. [The Four Questions Memnox Should Own](#9-the-four-questions-memnox-should-own)
10. [The OSS Wedge](#10-the-oss-wedge)
11. [The Core Positioning](#11-the-core-positioning)
12. [The One Sentence Above the Roadmap](#12-the-one-sentence-above-the-roadmap)
13. [Final Product Flywheel](#13-final-product-flywheel)

Appendix: [The phase index](#appendix-the-phase-index)

---

## 1. The Core Problem

AI agents are becoming capable of:

- Reading repositories
- Modifying code
- Executing commands
- Accessing GitHub
- Creating and closing issues
- Sending messages
- Accessing databases
- Calling APIs
- Deploying services
- Interacting with cloud infrastructure
- Using MCP servers
- Operating for long periods without human supervision

But developers and organisations increasingly face **three disconnected realities**:

```
┌─────────────────────────────────────┐
│      WHAT THE AGENT CAN DO          │
│                                     │
│  Permissions • MCP • Tools • Access │
└──────────────────┬──────────────────┘
                   │
                   ▼
┌─────────────────────────────────────┐
│      WHAT THE AGENT ACTUALLY DID    │
│                                     │
│  Actions • Tool calls • Changes     │
└──────────────────┬──────────────────┘
                   │
                   ▼
┌─────────────────────────────────────┐
│     WHAT HUMANS ACTUALLY INTENDED   │
│                                     │
│  Policies • Decisions • Context     │
└─────────────────────────────────────┘

                    ▲
                    │
                 MEMNOX
                    │
                    ▼

        ┌───────────────────────┐
        │ Technical Truth       │
        │ Runtime Truth         │
        │ Organizational Truth  │
        └───────────────────────┘
```

**This is the fundamental product problem.**

---

## 2. User Pain Brainstorm

> The pains below should **not** automatically become features.

Each pain should be evaluated through:

```
PAINFUL SITUATION
       ↓
WHY EXISTING TOOLS FAIL
       ↓
WHAT MEMNOX DOES
       ↓
WHAT THE USER GETS
```

---

### 2.1 I Don't Know What My AI Agent Can Access

**Pain**

A developer installs Claude Code, MCP servers, and other agents. Weeks later:

> "Wait… can this thing modify my GitHub?"
> "Does this MCP have access to my filesystem?"
> "Which tools can actually write data?"

Today, users often have to inspect configuration files manually.

**Memnox**

```bash
memnox scan
```

Discovers:

```
Agent
 ├── MCP servers
 ├── Tools
 ├── Repositories
 ├── Filesystem access
 ├── Credentials / configuration
 ├── Write capabilities
 └── Native security settings
```

**Example**

```
WOW — YOUR AI ENVIRONMENT

Claude Code
├── Filesystem
│   └── READ + WRITE
│
├── Shell
│   └── EXECUTE
│
└── GitHub MCP
    ├── 12 read tools
    └── 6 write tools

⚠ 6 write-capable capabilities detected
```

**User Value** — Visibility. The user finally understands their own AI environment.

---

### 2.2 I Gave the Agent Access Months Ago and Forgot About It

**Pain**

AI configuration is becoming permanent infrastructure. Developers add GitHub MCP, Slack MCP, Database MCP, Linear MCP, Stripe MCP, Filesystem MCP — then forget about them.

**Memnox**

```bash
memnox watch
```

Detects capability changes:

```
⚠ NEW MCP SERVER

Stripe
14 tools discovered
5 write-capable

No protection rule exists.

[ Review ]
[ Protect ]
```

**User Value** — Prevent forgotten AI permissions from becoming invisible permanent risk.

---

### 2.3 I Don't Know Which MCP Tools Are Dangerous

**Pain**

An MCP server might expose 30+ tools. The developer doesn't want to inspect every tool. They want to know:

> "Which ones can actually cause damage?"

**Memnox**

Classify tools by capability:

```
GitHub

READ
✓ list_repositories
✓ get_issue
✓ search_code

WRITE
⚠ create_issue
⚠ merge_pull_request
⚠ delete_branch
```

Instead of `31 tools`, Memnox tells the developer:

```
8 capabilities can change external state.
```

**User Value** — Understand capability, not just tool count.

---

### 2.4 I Want My AI to Be Autonomous, But I'm Scared

**Pain**

Developers want to say: *"Let Claude handle this overnight."* But then:

- What if it deletes something?
- What if it merges something?
- What if it sends something?
- What if it deploys?

So autonomy gets artificially limited.

**Memnox**

Turn risky actions into three decisions:

```
┌──────────┐   ┌──────────┐   ┌──────────┐
│  ALLOW   │   │   ASK    │   │   DENY   │
└──────────┘   └──────────┘   └──────────┘
```

Example:

```
Agent:
github.merge_pull_request

          ↓

       MEMNOX

          ↓

⚠ APPROVAL REQUIRED

[ Allow once ]   [ Deny ]
```

**User Value** — More autonomy without blind trust.

---

### 2.5 I Don't Want to Manually Approve Everything

**Pain** — the opposite problem. Without risk-based controls:

```
Read file?              → YES
Run command?            → YES
Create branch?          → YES
Create issue?           → YES
Modify file?            → YES
Merge production PR?    → YES
```

The AI is no longer autonomous.

**Memnox**

| Action | Decision |
| --- | --- |
| Read repository | ALLOW |
| Create local branch | ALLOW |
| Create GitHub issue | ALLOW |
| Merge production PR | ASK |
| Refund payment | ASK |
| Delete customer | DENY |

**User Value** — Remove unnecessary human approvals while keeping important ones.

---

### 2.6 Why Did Memnox Block My Agent?

**Pain**

Security systems often say `BLOCKED` and stop there. The developer asks: *"Why?"*

**Memnox**

```bash
memnox why <event>
```

```
ACTION
github.merge_pull_request

AGENT
Claude Code

DECISION
DENY

WHY?
GitHub branch protection requires 2 approvals.

EVIDENCE
• CODEOWNERS
• Branch protection
• PR #821

POLICY
Production changes require review.
```

**User Value** — Security becomes understandable instead of annoying.

---

### 2.7 The Agent Says It Can Do Something — But Can It Actually?

**Pain**

User asks: *"Can you deploy production?"* The agent says: *"Yes."*

But that doesn't necessarily mean it has the required credentials, permissions, repository access, deployment tools, or runtime authority.

**Memnox**

```
Can Claude deploy production?

CURRENT CAPABILITY
✓ AWS credentials
✓ Deployment CLI
✓ Production repository
✓ Deployment script

BUT
✗ Production deploy permission
✗ Required approval

RESULT
NOT AUTHORIZED
```

**User Value** — Replace AI assumptions with observed reality.

---

### 2.8 My Agent Has Access to Things It Doesn't Need

**Pain**

```
Coding Agent

NEEDS                 HAS
├── GitHub read       ├── GitHub admin
└── GitHub PR create  ├── AWS
                      ├── Stripe
                      ├── Slack
                      ├── Database
                      └── Filesystem
```

**Memnox**

```
UNUSED AUTHORITY

GitHub
24 tools available

Used:    6
Unused: 18

⚠ 3 unused tools can modify external state.
```

**User Value** — Reduce permissions based on actual usage rather than guesswork.

---

### 2.9 I Don't Know What Changed in My AI Environment

**Pain**

Yesterday everything worked. Today: *"Why does Claude suddenly have access to this?"*

Possible causes: new MCP, new credentials, changed permissions, new repository, modified configuration, changed agent instructions.

**Memnox**

```bash
memnox diff
```

```
CHANGES SINCE YESTERDAY

+ Slack MCP
+ 8 tools
+ AWS credential
+ /production directory access

Claude Code permissions

BEFORE          AFTER
READ            READ + WRITE
```

**User Value** — AI configuration drift becomes visible.

---

### 2.10 A New MCP Server Suddenly Appeared

**Memnox**

```
⚠ NEW CAPABILITY

MCP        Stripe
Tools      14 added
READ       9
WRITE      5

No policy exists.

[ Review ]
[ Protect ]
```

**User Value** — No silent expansion of agent authority.

---

### 2.11 My AI Is Using a Tool I Didn't Know Existed

**Memnox** — trace the capability:

```
ACTION
refund_payment
      │
      ▼
Stripe MCP
      │
      ▼
Agent
Hermes
      │
      ▼
SOURCE
stripe MCP configuration
      │
      ▼
ADDED
14 days ago
```

**User Value** — Capability provenance.

---

### 2.12 I Don't Know What My AI Actually Did While I Was Away

This becomes critical when agents operate asynchronously.

**Scenario**

Developer starts: *"Fix the authentication issue."* Three hours later, they return.

**Memnox Timeline**

```
10:04  Claude Code started
  │
10:04  read auth.ts
  │
10:07  searched repository
  │
10:11  modified auth.ts
  │
10:18  ran tests
  │
10:21  created branch
  │
10:25  opened PR
  │
10:31  attempted merge
  │
10:31  BLOCKED
```

**User Value** — A factual activity history instead of asking the agent to summarize itself.

---

### 2.13 I Don't Trust the Agent's Own Summary

**Agent says**

> "Deployment completed successfully."

**Memnox observes**

```
✓ Build
✓ Tests
✗ Deployment API call failed

STATUS
DEPLOYMENT FAILED
```

**User Value** — Independent observability. Memnox becomes the source of runtime truth.

---

### 2.14 The AI Did Something Weird. What Happened?

**Memnox Trace**

```
PRODUCTION CONFIG CHANGED
          │
          ▼
Agent: Claude Code
          │
          ▼
Tool: github.update_file
          │
          ▼
Human authorization: Moïse
          │
          ▼
Evidence: PR #921
          │
          ▼
RESULT
Configuration changed
```

**User Value** — Agent accountability.

---

### 2.15 Which Agent Did This?

As teams adopt Claude Code, Codex, Cursor, OpenCode, OpenClaw, Hermes, Devin — they begin to look identical from the outside.

**Memnox**

```
WHO ACTED?

Agent       OpenClaw
Identity    production-agent
Tool        deploy_service
Repository  payments
Time        14:03
```

**User Value** — Agent identity.

---

### 2.16 Two Agents Are Doing Conflicting Things

**Scenario**

Both agents are modifying the same production-critical file.

**Memnox**

```
⚠ AGENT CONFLICT

Claude Code ──┐
              ├── payments.ts
Codex ────────┘

[ Pause Claude ]
[ Pause Codex ]
[ Review ]
```

**User Value** — Prevent multi-agent collisions.

---

### 2.17 Two Agents Are Duplicating Work

**Memnox**

```
⚠ DUPLICATE WORK

Claude Code
└── OAuth token refresh

Codex
└── OAuth token refresh

Related:
PR #812
Issue #442
Branch: oauth-refresh
```

**User Value** — Prevent AI-driven duplicate engineering.

---

### 2.18 My AI Doesn't Know Our Team's Decisions

> This is where Memnox expands beyond security.

**Pain**

A team decides in Slack: *"Don't use Redis for this service."* Three weeks later, AI proposes Redis. Why? Because organizational decisions aren't necessarily stored in the repository.

**Memnox**

```
Question
Why shouldn't we use Redis here?

          ↓

MEMNOX SEARCH

Slack        Aug 12   Architecture discussion
Google Doc   Aug 13   ADR-019
GitHub                PR #821

          ↓

ANSWER

Redis was rejected because:

1. Team wants stateless deployment
2. Existing infrastructure doesn't support it
3. Decision recorded in ADR-019

Confidence: HIGH
```

**User Value** — Organizational memory with evidence.

---

### 2.19 The AI Keeps Violating Our Architecture

**Memnox**

```
AGENT ACTION
Added direct DB access

          ↓

CONFLICT
Architecture rule:
Services must use repository layer.

          ↓

EVIDENCE
ADR-023
AGENTS.md
```

**User Value** — Turn documentation into enforceable context.

---

### 2.20 Documentation Says One Thing; The System Does Another

> A particularly powerful enterprise pain.

```
DOCUMENTED
Production deployments require 2 approvals.

          ↓

ACTUAL SYSTEM
Production branch
└── No branch protection
```

**Memnox**

```
⚠ POLICY GAP

DOCUMENTED    2 approvals required
ACTUAL        0 approvals enforced

SOURCES
Security Policy
GitHub configuration
```

**User Value** — Find the gap between organizational intent and technical reality.

---

### 2.21 Nobody Knows Who Authorized the Agent

**Memnox**

```
ACTION          deploy payments-service
AGENT           Claude Code
AUTHORIZED BY   Sarah
AUTHORIZATION   Slack #platform, 09:42
RELATED         Jira PAY-821, PR #821
```

**User Value** — Human accountability around autonomous systems.

---

### 2.22 Why Was the Agent Allowed to Do That?

> The inverse of blocking.

```
WHY WAS THIS ALLOWED?

ACTION
merge PR #821

ALLOWED BECAUSE
✓ PR approved
✓ CODEOWNER approved
✓ Branch protected
✓ Deployment window open
✓ Policy allows production merge

AUTHORIZATION
Sarah + Daniel
```

**User Value** — Not only *"Why did we block it?"* but *"Why did we trust it?"*

---

### 2.23 What Happens If I Give the Agent More Access?

```
CURRENT          PROPOSED
GitHub           GitHub
├── read         ├── read
└── issues       ├── write
                 └── merge
```

**Memnox**

```
IMPACT

+3 capabilities
+2 external-state actions

Potential conflicts    2
Required approvals     1
```

**User Value** — Safe autonomy expansion.

---

### 2.24 Can This Agent Safely Perform This Task?

> This could become a killer command.

```bash
memnox explain "can Claude deploy payments?"
```

```
CAN IT?

Technically           YES
Organizationally      NO
Runtime permissions   YES
Current policy        DENY

REASON
Production deployment requires platform approval.

EVIDENCE
GitHub PR #821
Jira PAY-821
Slack #platform
```

**User Value** — One question instead of manually checking five systems.

---

### 2.25 The Information I Need Is Scattered Everywhere

**Pain** — a simple question may require Slack + GitHub + Jira + Docs + README + PRs.

**Memnox**

```
Why can't this agent deploy?
             ↓
           MEMNOX
             ↓
        ONE ANSWER
             ↓
        WITH EVIDENCE
             ↓
    FROM MULTIPLE SYSTEMS
```

**User Value** — Reduce organizational archaeology.

---

### 2.26 Company Decisions Disappear Into Slack

**Memnox** extracts durable decisions:

```
DECISION
"Use PostgreSQL instead of MongoDB."

PARTICIPANTS   Sarah, Daniel, Moïse
DATE           Aug 19
REASON         ...
RELATED        ADR-034, PR #812
```

**User Value** — Turn conversations into durable operational knowledge.

---

### 2.27 A New Engineer Doesn't Know Why Things Are the Way They Are

**Question** — *"Why is this weird service structured like this?"*

**Memnox**

```
WHY?  payments-service
          ↓
Decision              ADR-019
          ↓
Slack discussion      ...
          ↓
Related PR            ...
          ↓
Rejected alternatives ...
          ↓
Current implementation ...
```

**User Value** — Instant institutional context.

---

### 2.28 A Senior Engineer Left and Took the Context With Them

The code remains. The reasoning disappears.

**Memnox preserves**

| Dimension | Question |
| --- | --- |
| WHY | Why was this architecture chosen? |
| WHO | Who made the decision? |
| WHEN | When? |
| EVIDENCE | Slack, PRs, Docs, Issues |
| OUTCOME | What happened afterward? |

**User Value** — Knowledge continuity.

---

### 2.29 I Don't Know Whether an Old Decision Is Still Valid

```
DECISION
Use service A

STATUS
⚠ Possibly outdated

EVIDENCE
+ New architecture PR
+ New deployment configuration
+ Recent Slack discussion
```

**User Value** — Detect stale organizational knowledge.

---

### 2.30 Our Policies Are Written, But Nobody Follows Them

```
POLICY
Never deploy Friday afternoon.

          ↓

AGENT ACTION
Deploy Friday 16:45.

          ↓

MEMNOX

⚠ POLICY VIOLATION

Agent    Codex
Action   Production deployment
Policy   No production deployments after 16:00 Friday.
Result   BLOCKED
```

**User Value** — Policies become operational instead of PDFs nobody reads.

---

### 2.31 The Same Rule Needs to Work Across Every AI Agent

Teams may use Claude Code, Cursor, Codex, OpenClaw, Hermes — each with different configuration mechanisms.

**Memnox** — one conceptual policy:

```
Production deployment
        ↓
       ASK
```

Memnox translates that into each runtime's native controls.

**User Value** — One control plane across heterogeneous agents.

---

### 2.32 I Use Five AI Tools and Don't Know Which Is Safest

**Memnox**

```
AGENT COMPARISON

Claude Code   Risk: Medium
Codex         Risk: Low
OpenClaw      Risk: High

Why?

OpenClaw currently has:
• 3 write-capable tools
• Messaging capability
• Filesystem access
```

**User Value** — Understand the AI fleet instead of every agent individually.

---

### 2.33 My Agent's Capabilities Changed After an Update

**Memnox**

```
AGENT CHANGE

Claude Code

BEFORE   12 capabilities
AFTER    17 capabilities

NEW      +5 tools (2 write-capable)

[ Review ]
```

**User Value** — Agent updates become observable security events.

---

### 2.34 Someone Accidentally Exposed a Secret to an Agent

**Memnox**

```
⚠ NEW CREDENTIAL ACCESS

Agent        Claude Code
Resource     AWS production credentials

Previously   NOT AVAILABLE
Now          AVAILABLE

Detected     2 minutes ago
```

**User Value** — Catch dangerous capability expansion immediately.

---

### 2.35 The Agent Can Access Production When It Only Needs Development

```
ENVIRONMENT MISMATCH

Agent    Claude Code
Task     Local development
Access   Production database

Recommendation
REMOVE / PROTECT
```

**User Value** — Least privilege for AI agents.

---

### 2.36 The Agent Is Using Production Credentials for Development Work

```
TASK
Fix local login bug
          ↓
AGENT
Claude Code
          ↓
ACCESS
Production database
          ↓
⚠ UNNECESSARY PRODUCTION CAPABILITY
```

**User Value** — Make contextual over-privilege actionable.

---

### 2.37 I Installed an MCP But Don't Trust It

**Memnox**

```
MCP REVIEW

Server        unknown-server
Tools         21
READ          13
WRITE         8
Filesystem    YES
Network       YES
Credentials   AWS

Risk          HIGH

[ Protect ]
[ Disable ]
[ Inspect ]
```

**User Value** — Make MCPs inspectable before trust.

---

### 2.38 The Agent Has a Dangerous Tool, But I Don't Want to Remove the Whole MCP

```
STRIPE MCP

KEEP
✓ get_payment
✓ list_payments

PROTECT
⚠ refund_payment
⚠ create_payment

DENY
✕ delete_customer
```

**User Value** — Granular autonomy instead of all-or-nothing access.

---

### 2.39 The AI Can Message People

Agents increasingly gain the ability to send Slack messages, send emails, post publicly, create tickets.

**Memnox treats communication as external state.**

```
Agent wants:
slack.send_message

          ↓

MEMNOX

Decision:  ASK
Reason:    External communication
```

**User Value** — Prevent agents from speaking on behalf of humans without authorization.

---

### 2.40 The AI Created Something Externally Without Me Knowing

Potential external state: GitHub issue, Linear task, Jira ticket, Slack message, Pull request, Cloud resource.

**Memnox classifies**

```
LOCAL
   ↓
Usually ALLOW

EXTERNAL STATE
   ↓
ASK / POLICY

DESTRUCTIVE
   ↓
DENY
```

---

### 2.41 The AI Keeps Repeating the Same Mistake

**Memnox remembers**

```
Previous violation

Claude Code
↓
Bypassed repository layer

Blocked  Aug 12
Blocked  Aug 18
Blocked  Aug 29
```

Then:

```
⚠ REPEATED VIOLATION

This agent has attempted the same prohibited action 3 times.
```

**User Value** — Turn repeated failures into organizational learning.

---

### 2.42 We Don't Know Which AI Agents Are Actually Being Used

```
AI INVENTORY

Claude Code      14 users
Cursor           31 users
Codex             8 users
OpenClaw          3 users

MCP servers      42

Agents with
production access  7
```

**User Value** — Shadow AI visibility.

---

### 2.43 Someone Is Using an AI Agent Nobody Approved

```
⚠ UNREGISTERED AGENT

Agent       OpenClaw
User        Sarah
Connected   GitHub, Slack, Filesystem

Organization policy
Unapproved agents require review.
```

**User Value** — Discover shadow agents.

---

### 2.44 We Don't Know Which Agents Have Production Access

```bash
memnox who --resource production
```

```
PRODUCTION ACCESS

Claude Code   ✓
Codex         ✓
OpenClaw      ✓
Cursor        ✗
```

**User Value** — Instant blast-radius visibility.

---

### 2.45 We Don't Know Which Agents Can Touch Customer Data

```bash
memnox who --resource customer-data
```

```
AGENTS

Claude Code
✓ database.read

OpenClaw
✓ database.read
✓ database.write

Codex
✗
```

**User Value** — Understand sensitive-data exposure.

---

### 2.46 We Don't Know What an Agent Can Do Because Its Access Is Indirect

> A particularly interesting technical problem.

```
Claude Code
      │
      ▼
AWS MCP
      │
      ▼
AWS credentials
      │
      ▼
Lambda
      │
      ▼
Production DB
```

The agent may not directly have database access. But effectively:

```
Claude Code
      │
      ▼
EFFECTIVE CAPABILITY
WRITE → Production DB
```

**User Value** — Understand effective authority, not only direct permissions.

---

### 2.47 An Agent Can Chain Tools Together to Do Something Dangerous

Individual tools may appear harmless:

```
read_customer
      +
create_export
      +
send_file
      ↓
Customer-data exfiltration
```

**Memnox**

```
⚠ COMBINED CAPABILITY

Agent can:

READ customer records
        +
WRITE local files
        +
SEND external messages

Potential:
Customer-data export
```

**User Value** — Reason about what combinations of permissions enable.

> Note: a later-stage capability, but potentially extremely powerful.

---

### 2.48 Permissions Are Technically Valid but Contextually Wrong

Agent technically has deployment permission. But:

```
INCIDENT ACTIVE
       +
DEPLOYMENT FREEZE
       +
PRODUCTION ACTION

TECHNICALLY     ✓ Authorized
CONTEXTUALLY    ✗ Not authorized
```

**Memnox**

```
Reason:    Deployment freeze active.
Source:    Slack #incident
Incident:  INC-421
```

**User Value** — Ask not only *"Does the agent have permission?"* but *"Should the agent do this right now?"*

---

### 2.49 The Agent Doesn't Know We're in an Incident

```
Agent wants:
deploy payments

          ↓

MEMNOX checks:

Slack    ↓  Deployment freeze
Pager    ↓  INC-421 active
GitHub   ↓  PR pending

          ↓

DECISION
ASK / DENY
```

**User Value** — Give agents organizational situational awareness.

---

### 2.50 Our AI Has Context, But Not Authority

> One of the most important conceptual distinctions.

An agent might know *"We normally deploy after review."* But knowledge isn't enforcement.

**Memnox**

```
KNOWLEDGE
     +
EVIDENCE
     +
CURRENT STATE
     +
POLICY
     ↓
  MEMNOX
     ↓
┌────────┬────────┬────────┐
│ ALLOW  │  ASK   │  DENY  │
└────────┴────────┴────────┘
```

**Core Idea** — Knowledge + evidence + current state → enforceable decision.

---

### 2.51 We Need to Know Why an AI Made a Decision

Eventually Memnox should trace:

```
AGENT → TASK → CONTEXT → EVIDENCE → POLICY → HUMAN APPROVAL → ACTION → OUTCOME
```

**User Value** — Explainable autonomous operations.

---

### 2.52 We Can't Investigate an AI Incident

**Current reality** — investigation may require GitHub logs + Cloud logs + Slack + CI + Agent logs + MCP logs.

**Memnox**

```
INCIDENT #421

14:02  Agent started
14:04  Accessed production
14:05  Modified configuration
14:05  Deployment triggered
14:06  Deployment failed

Agent    Claude Code
User     Sarah
Tool     github.update_file
Related  PR #921
```

**User Value** — AI incident investigation.

---

### 2.53 We Don't Know Whether a Human or AI Caused an Action

Memnox should normalize actors: `HUMAN` · `AI AGENT` · `CI` · `AUTOMATION` · `SERVICE`

Then answer *"Who actually caused this change?"* instead of only *"Who pressed the button?"*

**User Value** — Causal accountability.

---

### 2.54 We Need an Audit Trail for AI Actions

For meaningful actions:

```
WHO · WHAT · WHEN · WHERE · WHY · AUTHORIZED BY · POLICY · EVIDENCE · OUTCOME
```

**User Value** — Accountability, incident response, security review, internal audit.

---

### 2.55 AI Permissions Keep Growing But Nobody Notices

```
AI AUTHORITY OVER TIME

January    ██████
February   ████████
March      ██████████████
April      ████████████████████

+217% authority
```

Potential insight:

> "Your agents now have 4.2× more external write capability than 90 days ago."

**User Value** — AI privilege drift becomes measurable.

---

### 2.56 Our AI Environment Is Becoming Too Complicated

Eventually a company may have 43 agents, 112 MCP servers, 1,200 tools, 87 repositories, 26 policies, 14,000 decisions. Nobody can reason about the entire system.

**Memnox Normalized Model**

```
Agent → Capability → Resource → Identity → Policy → Evidence → Decision → Outcome
```

This is where the **Decision Graph** becomes useful.

---

### 2.57 We Don't Know What the Company Has Implicitly Authorized

A company may never explicitly write *"Claude can merge PRs."* But perhaps:

```
CODEOWNERS allows it
       +
Branch rules allow it
       +
Slack says "Claude can handle these"
       +
Manager approved the agent
       +
Previous PRs were merged
```

Memnox can eventually derive:

```
OBSERVED AUTHORIZATION

Source
Slack
GitHub
Previous approvals
Current configuration
```

**User Value** — Understand implicit organizational authorization.

---

### 2.58 Written Policy and Actual Human Behavior Disagree

```
POLICY
Every production deploy requires 2 approvals.

          ↓

OBSERVED BEHAVIOR
73% follow policy
27% bypass it

Common exception:
Platform lead approval in Slack
```

**User Value** — Understand how organizations actually operate.

---

### 2.59 We Keep Answering the Same AI Permission Questions

| Who | Question |
| --- | --- |
| Developer | Can Claude merge? |
| Security | Which agents access GitHub? |
| Manager | Who approved this? |
| Platform | What changed? |

**Memnox becomes the answer layer**

| Question | Layer |
| --- | --- |
| What can it do? | Capability |
| What did it do? | Runtime |
| Why? | Evidence |
| Who allowed it? | Identity |
| What happens if we change it? | Simulation |

---

### 2.60 I Want to Ask Memnox a Normal Question

The ideal UX should not require another dashboard. Instead:

```bash
memnox explain "Can Claude safely deploy payments right now?"
memnox why     "Was the production deploy blocked?"
memnox who     "Can modify the payments database?"
memnox what-if "What happens if I give Codex production access?"
```

This maps to four fundamental questions:

```
┌─────────────────────────────────────┐
│  WHAT CAN AGENTS DO?                │
└──────────────────┬──────────────────┘
                   ↓
┌─────────────────────────────────────┐
│  WHAT ARE THEY DOING?               │
└──────────────────┬──────────────────┘
                   ↓
┌─────────────────────────────────────┐
│  WHY ARE THEY ALLOWED?              │
└──────────────────┬──────────────────┘
                   ↓
┌─────────────────────────────────────┐
│  WHAT IF WE GIVE THEM MORE POWER?   │
└─────────────────────────────────────┘
```

---

### 2.61 The Nine Seconds Between "Be Helpful" and No Database

**Pain**

An agent is asked to clean up an environment. It scans the filesystem, finds a cloud
token that was over-privileged two years ago, and issues a volume delete. Nine seconds
between the prompt and an empty production database. Nobody was watching, because
watching was not the job.

The prompt said *don't touch production*. The prompt is not on the execution path.

**Why existing tools fail**

A system prompt is a request. An IAM policy is written months earlier by somebody who
did not know today's incident was open. Neither of them knows that four minutes ago
somebody wrote "freeze production while we troubleshoot" in an ops channel — which is
the only fact in the room that would have stopped it.

**Memnox**

The refusal carries the evidence that produced it:

```
[Memnox] cursor tried to run: railway volume delete pg-prod

  DENIED  no volume deletes while payments is frozen

  what said so
    freeze:payments        declared 4 min ago by moise, 1h 56m left
    memnox.policies.toml   line 34, railway-destructive
    .github/CODEOWNERS     infra/ is owned by @platform

  [d] deny and tell the agent   [e] edit the command   [o] overrule, recorded
```

**What the user gets**

A refusal that is arguable. `[e]` opens the command in an editor so a wrong flag can be
fixed without killing the agent's loop; `[o]` lets a person overrule, and the overrule is
a row in the ledger with their name on it, because an override nobody can find later is
just a slower allow.

---

### 2.62 The Overnight Loop That Left the Working Tree in Pieces

**Pain**

An agent runs unsupervised for three hours. It writes a broken migration, reformats forty
files it was not asked to touch, and deletes a directory it misread as generated. None of
it is committed. `git checkout .` throws away the good with the bad, and there is no
commit to go back to because the agent never made one.

The morning is spent untangling, and the lesson learned is *do not run it unsupervised* —
which is the opposite of the point.

**Why existing tools fail**

Undo in an editor is per-file and dies with the window. A container is a different
machine, so the work is not there afterwards. Committing before every agent run pollutes
the history with commits nobody meant.

**Memnox**

A milestone is a tree object, taken the moment an agent task starts, stored under
`refs/memnox/` where nothing else looks:

```bash
memnox rewind                    # back to before the last agent task
memnox rewind --list             # the milestones there are
memnox rewind --to mst_a1b2c3    # back to a named one
```

It moves the working tree only. Never a commit, never a branch, never the stash. And a
rewind takes its own milestone first, so the thing it replaced is still reachable.

**What the user gets**

The nerve to let it run. That is the whole feature: not the rollback, the willingness.

---

### 2.63 I Want to Know Before the Loop, Not During It

**Pain**

The decision to let an agent run is made once, at the start, with no information. Half an
hour later it hits the one thing it should not have touched, and the choice is to abandon
the run or approve under pressure.

**Why existing tools fail**

Every gate in the category is an interrupt. Interrupts are answered by whoever is in the
terminal, at the moment they are least able to think about it, and the answer is almost
always yes.

**Memnox**

```bash
memnox check "deploy the payments service"
```

The same engine, the same rules, the same state — run ahead of time against the actions
that intent resolves to, with nothing executed:

```
  deny   railway.deploy-prod    freeze:payments, 1h 56m left
  ask    gh.pr-merge            merges are reviewed
  allow  npm.test

  1 of 3 would stop. Lift the freeze or pick a different service.
```

**What the user gets**

The expensive decision made when it is cheap.

---

### 2.64 What Actually Came Out of That Command

**Pain**

The timeline says the deploy ran and exited zero. It does not say what it printed, and the
agent's own account of it is a summary written by something with an interest in the
summary being good.

**Why existing tools fail**

Shell history has the command and not the output. The agent transcript has the agent's
version. Neither is the process's own stream.

**Memnox**

```bash
memnox trace evt_01H8X
```

One action: the command, the rule that governed it, the exit code, the duration, and the
first and last of what it actually wrote to stdout and stderr — recorded locally, capped,
retention-bound, and never sent anywhere.

**What the user gets**

The difference between "it says the tests passed" and "the tests passed".


---

### 2.65 Three Agents, One Repository, and Nobody Told Anybody

**Pain**

Cursor is writing a feature in `src/billing`. Claude Code, in the next terminal, is
refactoring the directory layout and moves the file out from under it. A third agent runs
the test suite against a tree that is now half of each. Nothing crashed and nothing was
denied — every one of the three did exactly what it was asked. The developer finds out at
`git status`, and the afternoon goes on untangling it.

This is [2.16](#216-two-agents-are-doing-conflicting-things) after the fact. 2.16 says
*that happened*; this one is about it not happening.

**Why existing tools fail**

Git locks nothing until a commit, and none of this was committed. An editor's file lock is
about two humans in one buffer, not two processes with their own working assumptions. Each
agent's own sandbox makes the problem worse, not better: three isolated views of one
directory is exactly how you get three answers.

Nothing in the stack knows that an agent has *taken* a piece of the tree, because until
now nothing was watching what an agent touched at the moment it touched it. Memnox already
is.

**Memnox**

A lease on a path, taken at the first write and held for the session:

```bash
memnox lock --list
memnox lock src/billing --for 30m     # take one by hand
memnox lock --release <id>
```

```
[Memnox] claude-code wants to write src/billing/invoice.ts

  HELD    cursor has src/billing since 4 min ago (ses_9f21, 26m left)

  what it is doing
    wrote  src/billing/invoice.ts, src/billing/plan.ts
    ran    npm test -- billing

  [w] wait for it   [t] take it anyway, recorded   [d] don't
```

**What the user gets**

Two agents in one repository stop being a coin flip. The second one waits, or is told who
holds it and what they have been doing, which is the sentence that ends the argument.

**The four things that decide whether this is usable**

1. **It locks paths, not meaning.** A "semantic lock on a module" is a nice phrase and an
   undecidable problem. What can be enforced deterministically is a path prefix, and a
   path prefix is what a refactor collides on anyway. Anything cleverer is a guess, and a
   guess that blocks work is a feature people turn off.
2. **A lock never blocks a read.** Two agents reading one directory is normal and always
   was. Only a write takes a lease, and only a write waits on one.
3. **Every lease expires, and the owner's death releases it.** A lock that outlives its
   session is worse than no lock, because the next one gets forced and then all of them
   do. A lease carries an expiry, and a lease whose process is gone is reclaimed rather
   than waited on. Same rule as a freeze: `stateFactsInForce` takes the moment as an
   argument and nothing here reads a clock behind the caller's back.
4. **Waiting is bounded, and taking it anyway is a row.** An agent's tool call has its own
   timeout, so a wait that outlasts it is a hang dressed as a queue. The wait has a
   ceiling, after which it is a refusal that names the holder. `[t]` exists because the
   holder is sometimes an agent that died three hours ago in a way nothing detected — and
   `[t]` is recorded, with who and why, or it is just a slower allow.

**Where this stops being local**

One laptop running Cursor and Claude Code is the common case and needs no account. Two
laptops on one repository is a different problem: the lease has to live somewhere both can
see, and that is the cloud half. The runtime builds the broker and the file-backed lease
so it is useful alone; the cloud makes the lease shared, which is the part a team pays for.


---

## 3. The Pains I Would Prioritize

> Not all 65 pains should become features.

| Priority | User Pain | Memnox Answer | Who Feels It |
| --- | --- | --- | --- |
| 🔥 1 | What can my agent access? | `memnox scan` | Developer |
| 🔥 2 | Can I safely let it run? | `memnox protect` | Developer |
| 🔥 3 | What did it actually do? | Runtime activity | Developer |
| 🔥 4 | Why was it blocked/allowed? | `memnox why` | Developer |
| 🔥 5 | What changed? | `memnox diff` | Developer |
| 🔥 6 | This MCP has too much access | Capability analysis | Developer |
| 🔥 7 | Can this agent do X? | `memnox explain` | Developer |
| 🔥 8 | AI violated our team's decision | Organizational evidence | Team |
| 🔥 9 | Why isn't this action authorized? | GitHub + Slack + Jira + Docs | Team |
| 🔥 10 | Who authorized this? | Identity + evidence | Company |
| 🔥 11 | Which agents have production access? | Agent/resource graph | Platform |
| 🔥 12 | Policy says X, reality says Y | Policy/runtime gap | Enterprise |
| 🔥 13 | Two agents are conflicting | Agent coordination | Engineering |
| 🔥 14 | We lost the reasoning behind this | Decision history | Engineering |
| 🔥 15 | Give agents more autonomy safely | What-if/control | Enterprise |
| 🔥 16 | It ruined my working tree overnight | `memnox rewind` | Developer |
| 🔥 17 | Decide before the loop, not during it | `memnox check` | Developer |
| 🔥 18 | What did that command actually print? | `memnox trace` | Developer |
| 🔥 19 | Two agents overwrote each other | `memnox lock` | Team |

---

## 4. Three Layers of Pain

Memnox should evolve through three layers.

```
┌───────────────────────────────────────────┐
│              LAYER 3                      │
│            COMPANY PAIN                   │
│                                           │
│  Agents • MCP • GitHub • Slack • Jira     │
│  Linear • Docs • CI/CD • Cloud            │
│                                           │
│           Decision Graph                  │
└─────────────────────▲─────────────────────┘
                      │
┌─────────────────────┴─────────────────────┐
│              LAYER 2                      │
│         ENGINEERING-TEAM PAIN             │
│                                           │
│  Decisions • Policies • Architecture      │
│  Evidence • Agent conflicts • Context     │
└─────────────────────▲─────────────────────┘
                      │
┌─────────────────────┴─────────────────────┐
│              LAYER 1                      │
│        PERSONAL DEVELOPER PAIN            │
│                                           │
│  Access • Actions • Risk • Autonomy       │
│                                           │
│  scan • explain • protect • watch         │
│  why • diff                               │
└───────────────────────────────────────────┘
```

### 4.1 Layer 1 — Personal Developer Pain

**This is the OSS wedge.**

```
I use AI agents
       ↓
I don't know what they can access
       ↓
I don't know what they're doing
       ↓
I'm afraid to give them more autonomy
       ↓
              MEMNOX
       ↓
┌──────────────────────────────┐
│ memnox scan                  │
│ memnox explain               │
│ memnox protect               │
│ memnox watch                 │
│ memnox why                   │
│ memnox diff                  │
└──────────────────────────────┘
```

**First Experience**

```
INSTALL → SCAN → DISCOVER → EXPLAIN → FIX → WATCH
```

This should remain extremely small.

### 4.2 Layer 2 — Engineering-Team Pain

Now connect organizational sources:

```
GitHub ──────┐
Slack ───────┤
Jira ────────┤
Linear ──────┤
Docs ────────┤
ADRs ────────┤
Runbooks ────┘
       │
       ▼
    MEMNOX
       │
       ▼
   AI AGENTS
```

The questions change:

- Why did the agent do this?
- Does this violate our architecture?
- Who decided this?
- Is this decision still valid?
- Is this agent allowed to do this?
- Are two agents conflicting?
- What changed?

This is where organizational memory becomes useful rather than just another searchable knowledge base.

### 4.3 Layer 3 — Company Pain

```
              MEMNOX
                 │
 ┌───────────────┼────────────────┐
 │               │                │
 ▼               ▼                ▼
Agents          MCP             GitHub
 │               │                │
 ▼               ▼                ▼
Slack           Jira            Linear
 │               │                │
 ▼               ▼                ▼
Docs            CI/CD           Cloud
 └───────────────┬────────────────┘
                 ▼
          DECISION GRAPH
                 │
                 ▼
      ORGANIZATIONAL TRUTH
```

The company can then answer:

```
What AI do we have?
        ↓
What can it access?
        ↓
What is it doing?
        ↓
Who authorized it?
        ↓
Why was it allowed?
        ↓
Did it follow company policy?
        ↓
What changed?
        ↓
What happens if we give it more autonomy?
```

---

## 5. The 10 WOWs I'd Actually Build

If the entire brainstorm had to be reduced to the things capable of making users say
*"Holy shit."* — 1 to 10 are the original set, 11 and 12 are the two that came out of
watching what people actually lose:

| # | WOW | The user reaction |
| --- | --- | --- |
| 1 | `memnox scan` | "I didn't know my agent had all this access." — Real machine, real configuration, no demo data. |
| 2 | `memnox explain` | "Now I understand exactly what it can do." |
| 3 | `memnox protect` | "It fixed the dangerous access without me learning another security system." |
| 4 | `memnox watch` | "Someone added an MCP and Memnox immediately noticed." |
| 5 | Runtime Interception | "My agent actually tried to do that." — Observe the real action, not what the agent claims it did. |
| 6 | `memnox why` | "I know exactly why it was blocked." — With real evidence. |
| 7 | `memnox diff` | "Something changed, and Memnox found it." |
| 8 | Cross-Agent View | "I can finally see my AI fleet." — Claude Code, Cursor, Codex, OpenClaw, Hermes in one place. |
| 9 | Organizational Answer | "Memnox checked everything and told me whether this action is actually allowed." |
| 10 | What-If | "Before giving my agent more power, I can see what that actually enables." |
| 11 | `memnox rewind` | "It wrecked the branch and I got it back in one command." — The one that changes behaviour: people start letting agents run unsupervised. |
| 12 | The justified refusal | "It blocked it, and then showed me the Slack message that said to." |
| 13 | `memnox lock` | "The second agent waited instead of trampling the first." — Two agents in one repository stop being a coin flip. |

**WOW 9 — Organizational Answer**

```
Slack + GitHub + Jira + Docs
              ↓
           MEMNOX
              ↓
   ONE ANSWER + REAL EVIDENCE
```

**WOW 10 — What-If**

```
"What happens if I give Codex production access?"

CURRENT               Read-only
PROPOSED              Read + Write + Deploy

NEW CAPABILITIES      +3
NEW EXTERNAL ACTIONS  +2
POLICY CONFLICTS      2
REQUIRED APPROVALS    1
```

---

## 6. The Ultimate Memnox Loop

> This is the product loop to obsess over.

```
┌────────────────────────────┐
│          INSTALL           │
└──────────────┬─────────────┘
               ↓
┌────────────────────────────┐
│            SCAN            │
└──────────────┬─────────────┘
               ↓
     "Whoa, my agent can do THAT?"
               ↓
┌────────────────────────────┐
│          EXPLAIN           │
└──────────────┬─────────────┘
               ↓
        "Okay, protect it."
               ↓
┌────────────────────────────┐
│          PROTECT           │
└──────────────┬─────────────┘
               ↓
       Agent works autonomously
               ↓
       REAL ACTION HAPPENS
               ↓
┌────────────────────────────┐
│          OBSERVE           │
└──────────────┬─────────────┘
               ↓
       ALLOW / ASK / DENY
               ↓
            "Why?"
               ↓
┌────────────────────────────┐
│  EXPLAIN WITH REAL EVIDENCE│
└──────────────┬─────────────┘
               ↓
       User trusts Memnox
               ↓
      Configuration changes
               ↓
┌────────────────────────────┐
│            WATCH           │
└──────────────┬─────────────┘
               ↓
        User connects
   GitHub → Slack → Jira → Docs
               ↓
┌────────────────────────────┐
│   MEMNOX LEARNS            │
│   ORGANIZATIONAL INTENT    │
└──────────────┬─────────────┘
               ↓
   "Should this agent be allowed?"
               ↓
┌────────────────────────────┐
│      MEMNOX ANSWERS        │
└──────────────┬─────────────┘
               ↓
  "Can we give it MORE autonomy?"
               ↓
┌────────────────────────────┐
│    WHAT-IF SIMULATION      │
└──────────────┬─────────────┘
               │
               └───────────────┐
                               ↓
                         MORE AUTONOMY
                               ↓
                            OBSERVE  ──► (loop)
```

**This is the real product flywheel.**

---

## 7. The Product Evolution

```
             TODAY
               │
               ▼
        ┌──────────────┐
        │ Agent Access │
        │ Visibility   │
        └──────┬───────┘
               ▼
        ┌──────────────┐
        │   Runtime    │
        │  Protection  │
        └──────┬───────┘
               ▼
        ┌──────────────┐
        │ Observability│
        │  + Evidence  │
        └──────┬───────┘
               ▼
        ┌──────────────┐
        │Organizational│
        │    Memory    │
        └──────┬───────┘
               ▼
        ┌──────────────┐
        │   Policy +   │
        │   Authority  │
        └──────┬───────┘
               ▼
        ┌──────────────┐
        │  What-If /   │
        │  Simulation  │
        └──────┬───────┘
               ▼
        ┌──────────────┐
        │  Autonomous  │
        │  Operations  │
        └──────────────┘
```

---

## 8. The Core Memnox Model

Everything eventually connects to one normalized model:

```
┌─────────────┐
│    AGENT    │
└──────┬──────┘
       ▼
┌─────────────┐
│ CAPABILITY  │
└──────┬──────┘
       ▼
┌─────────────┐
│  RESOURCE   │
└──────┬──────┘
       ▼
┌─────────────┐
│  IDENTITY   │
└──────┬──────┘
       ▼
┌─────────────┐
│   POLICY    │
└──────┬──────┘
       ▼
┌─────────────┐
│  EVIDENCE   │
└──────┬──────┘
       ▼
┌─────────────┐
│  DECISION   │
└──────┬──────┘
       ▼
┌─────────────┐
│   OUTCOME   │
└─────────────┘
```

---

## 9. The Four Questions Memnox Should Own

Everything ultimately reduces to four questions:

```
┌────────────────────────────────────────┐
│       WHAT CAN IT DO?                  │
│       Capabilities / Access            │
└───────────────────┬────────────────────┘
                    ↓
┌────────────────────────────────────────┐
│       WHAT IS IT DOING?                │
│       Runtime / Actions                │
└───────────────────┬────────────────────┘
                    ↓
┌────────────────────────────────────────┐
│       WHY IS IT ALLOWED?               │
│       Policy / Evidence / Authority    │
└───────────────────┬────────────────────┘
                    ↓
┌────────────────────────────────────────┐
│       WHAT IF WE GIVE IT MORE POWER?   │
│       Simulation / Consequences        │
└────────────────────────────────────────┘
```

---

## 10. The OSS Wedge

For the open-source product, **do not** try to implement all 65 pains. The initial product should focus on the local developer's immediate problem:

```
                 AI AGENT
                    │
                    ▼
              ┌───────────┐
              │  MEMNOX   │
              └─────┬─────┘
                    │
       ┌────────────┼────────────┐
       ▼            ▼            ▼
     ACCESS       ACTION       CHANGE
       │            │            │
       ▼            ▼            ▼
     SCAN        OBSERVE        DIFF
       │            │            │
       └────────────┼────────────┘
                    ▼
             PROTECT / ASK
                    │
                    ▼
               EXPLAIN WHY
```

**Initial OSS commands**

```bash
memnox scan
memnox explain
memnox protect
memnox watch
memnox why
memnox diff
memnox check
memnox rewind
memnox trace
```

`rewind` is the wedge inside the wedge. Everything else on that list asks somebody to
care about governance before anything has gone wrong; `rewind` pays them back the first
morning an agent leaves a mess, and it works on one laptop with no account, no network
and nothing to configure.

**The first experience**

```
INSTALL
   ↓
SCAN
   ↓
"Whoa."
   ↓
EXPLAIN
   ↓
PROTECT
   ↓
WATCH
   ↓
OBSERVE REAL ACTIONS
   ↓
ALLOW / ASK / DENY
```

---

## 11. The Core Positioning

Do **not** reduce Memnox to "AI security", "AI governance", "AI memory", or "Agent monitoring". Those are components.

The deeper problem is:

> **Loss of control and understanding as AI becomes autonomous.**

---

## 12. The One Sentence Above the Roadmap

> **Memnox solves the gap between what AI agents can do, what they actually do, and what your organization intended them to do.**

The user-facing progression:

```
WHAT CAN IT DO?
        ↓
WHAT IS IT DOING?
        ↓
WHY IS IT ALLOWED?
        ↓
WHAT IF WE GIVE IT MORE POWER?
```

That is the product.

---

## 13. Final Product Flywheel

```
              ┌─────────────────┐
              │  UNDERSTAND     │
              │  AI CAPABILITY  │
              └────────┬────────┘
                       ↓
              ┌─────────────────┐
              │    CONTROL      │
              │  AI AUTHORITY   │
              └────────┬────────┘
                       ↓
              ┌─────────────────┐
              │    OBSERVE      │
              │  REAL ACTIONS   │
              └────────┬────────┘
                       ↓
              ┌─────────────────┐
              │    EXPLAIN      │
              │ WITH EVIDENCE   │
              └────────┬────────┘
                       ↓
              ┌─────────────────┐
              │    REMEMBER     │
              │ ORGANIZATIONAL  │
              │     INTENT      │
              └────────┬────────┘
                       ↓
              ┌─────────────────┐
              │    SIMULATE     │
              │ MORE AUTONOMY   │
              └────────┬────────┘
                       ↓
              ┌─────────────────┐
              │   TRUST AI      │
              │   TO DO MORE    │
              └────────┬────────┘
                       │
                       └──────────► MORE AUTONOMY ──► OBSERVE (loop)
```

**Memnox is the layer that makes autonomous AI understandable, controllable, and progressively trustworthy.**

---

## Appendix: the phase index

The build sequence is cited by number across all three repositories, from `CLAUDE.md`,
`CONTRIBUTING.md`, `CHANGELOG.md` and source comments. This table is what makes those
citations resolve: a phase is the engineering that closes a group of the pains above.

| Phase | Owns | Closes |
|---|---|---|
| `§01` Discovery | what can act here, what it reaches, findings, reversible harden steps | 2.1, 2.3, 2.7, 2.11, 2.34, 2.35, 2.46 |
| `§02` Evidence | one normalized model, defined once, that every later phase writes into | 2.56 |
| `§03` Observation | seams, interception both ways, the ledger, frames, lineage | 2.12, 2.13, 2.14, 2.16, 2.36, 2.39, 2.40, 2.51, 2.64 |
| `§04` Explain | the deterministic answer, built from the match and never from a model | 2.6, 2.22, 2.24, 2.25, 2.60 |
| `§05` Protect | policies, the three effects, proposals, simulation, native controls | 2.4, 2.5, 2.30, 2.31, 2.38 |
| `§06` Watch | configuration and behaviour drift, with the cause named | 2.2, 2.9, 2.10, 2.33, 2.55 |
| `§07` Repository evidence | CODEOWNERS, ADRs, AGENTS.md, branch rules, already on disk | 2.19, 2.20, 2.57 |
| `§08` Organizational evidence | Slack, Jira, Linear, Notion, Drive, and current state | 2.18, 2.26, 2.27, 2.28, 2.29, 2.48, 2.49, 2.58 |
| `§09` Policy candidates | the bridge from what was observed to what is enforced | 2.8, 2.41, 2.50 |
| `§10` Cloud | identity, the fleet, approvals, chains, evidence, autonomy | 2.15, 2.17, 2.21, 2.23, 2.32, 2.37, 2.42, 2.43, 2.44, 2.45, 2.47, 2.52, 2.53, 2.54, 2.59 |
| `§11` Recovery | milestones, rewind, pre-flight, the raw stream behind one action | 2.61, 2.62, 2.63, 2.64 |
| `§12` Coordination | leases on paths, the broker, waiting and taking | 2.16, 2.17, 2.65 |

**Why this order.** Discovery first, because a count read off the reader's own disk is the
only honest aggregate at minute zero. The model before the sources, which is why §07, §08
and §09 add evidence without a rewrite. Observation before enforcement, because a verdict
nobody is obliged to ask for is advice. Explanation before protection, because a block a
user cannot interrogate is a block they will disable. Evidence before policy, because a
policy editor opened before there is traffic to write about is a blank form. Repository
before Slack, because level two evidence needs no account. Local before cloud, because the
open half's entire credibility is that nothing leaves the machine.
