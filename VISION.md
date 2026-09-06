# Memnox — Control Plane for Autonomous Work

**Strategy note: repositioning Memnox from "AI security" to "the thing that lets you safely increase agent autonomy."**

---

## The core repositioning

Don't sell "protection." Sell the ability to **safely increase agent autonomy**.

The agents already do the work. Memnox should become the thing that makes users comfortable saying:

> "Go ahead. Handle it yourself."

That creates a much stronger paid product.

---

## The Memnox opportunity

Across all three ecosystems, the same pattern appears:

```
Hermes       → long-running autonomous worker
OpenClaw     → always-on personal/business operator
Ruflo        → multi-agent engineering workforce
                    │
                    ▼
             MORE AUTONOMY
                    │
                    ▼
              MORE ACCESS
                    │
                    ▼
             MORE CONSEQUENCE
                    │
                    ▼
             LESS HUMAN TRUST
```

Memnox sits exactly at the last step. It should turn:

> "I don't trust this agent enough to let it run unattended."

into:

> "Memnox is watching it. Let it run."

---

## 1. The first addictive feature: Autopilot

This should be the heart of Memnox. Not a security dashboard.

A user chooses: **Run this agent autonomously.** Memnox creates the boundary automatically.

For example, an OpenClaw running a business operations workflow:

```
OPENCLAW AUTOPILOT

Allowed automatically:
✓ read email
✓ classify email
✓ create CRM records
✓ research prospects
✓ draft responses
✓ update task lists
✓ create documents

Needs approval:
⚠ send external email
⚠ modify CRM records
⚠ publish content

Never allowed:
✕ transfer money
✕ delete customer data
✕ access private credentials
✕ change account ownership
```

The user doesn't need to understand IAM, MCP permissions, Linux permissions, OAuth scopes, etc. Memnox translates "let my agent work" into enforceable boundaries.

---

## 2. Hermes: turn overnight automation into Overnight Autopilot

A developer says: *"Tonight, let Hermes fix the failing CI pipeline."*

Memnox says — **Overnight Autopilot**:

```
Hermes can:

✓ inspect logs
✓ inspect repository
✓ modify files
✓ run tests
✓ create branches
✓ create PRs

Cannot:

✕ merge directly to main
✕ deploy production
✕ modify secrets
✕ modify IAM
✕ delete infrastructure
```

Then Hermes gets stuck. Instead of allowing six hours of recursive retries:

```
03:14   Test failed
03:18   Retry
03:26   Retry
03:41   Same failure
03:52   Memnox: STOP
```

Memnox detects:

```
Same command: 11 times
Same error: 11 times
No state improvement
Token spend increasing
```

Then: **AUTONOMOUS LOOP STOPPED**

> Hermes has attempted the same remediation 11 times with no measurable progress. Estimated additional spend: $14.20/hour. Task paused.

That's directly monetizable. You're not merely securing Hermes — you're preventing autonomous agents from burning money while accomplishing nothing.

---

## 3. Make this universal: Agent Circuit Breaker

This should work across Hermes, OpenClaw, Ruflo, Claude Code, Codex, etc. Memnox watches execution and detects:

| Signal | Pattern |
|---|---|
| Retry loop | same action × 10 |
| Error loop | same failure × 5 |
| Token burn | $18 spent, 0 progress |
| Action explosion | expected 20 actions, actual 1,200 |
| Scope drift | task: "fix checkout" → actual: modifying authentication system |

Then: **Memnox paused the agent.**

This is an extremely strong reason to pay.

---

## 4. Hermes self-learning creates another killer feature

Hermes can create skills and improve itself. That means:

```
Agent learns
      ↓
Skill changes
      ↓
Future behavior changes
```

That's dangerous. Memnox should treat every newly generated skill like a software deployment.

**Hermes:** "I created a new skill."

**Memnox:**

```
NEW AGENT CAPABILITY

Skill:
deploy-production

Previously:
No production deployment

Now:
✓ AWS access
✓ Kubernetes
✓ production deployment

Risk:
CRITICAL

Status:
QUARANTINED
```

Then: **Review new skill.** The user sees exactly what changed.

This solves: *"My agent is silently becoming more powerful."* And that's a very strong recurring reason to keep Memnox running.

---

## 5. OpenClaw: make the agent safe enough to become a 24/7 employee

OpenClaw's biggest appeal is that people can put it on a VPS and let it operate through messaging channels. But imagine a user connects:

```
Email · Calendar · CRM · Browser · GitHub · Cloudflare · AWS · Stripe · Slack
```

OpenClaw becomes a digital employee. Memnox gives that employee a **job description**:

```
AI Sales Employee

MISSION
Generate qualified leads.

CAN:
✓ research companies
✓ enrich prospects
✓ update CRM
✓ draft outreach
✓ schedule meetings

CAN'T:
✕ send bulk campaigns
✕ modify pricing
✕ access payment data
✕ issue refunds
✕ impersonate executives
```

That's the key: **Memnox should increase the amount of authority users are willing to delegate.**

---

## 6. Build Progressive Autonomy

This could become one of your signature concepts. Instead of `ALLOW / DENY`, Memnox has:

```
OBSERVE
    ↓
ASSIST
    ↓
SUPERVISED
    ↓
AUTONOMOUS
    ↓
TRUSTED
```

**Week 1** — Hermes: "Can I deploy staging?" Human: Yes. Memnox records that.

**Week 2** — Memnox: "You approved 23 identical staging deployments. Enable autonomous staging deployments?" User: Yes.

**Week 4** — Memnox: "You've approved 17 production rollbacks during incidents. Allow automatic rollback when the deployment is <30 minutes old and the health check fails?" User: Yes.

The user's agent becomes more autonomous over time without becoming uncontrolled. That's addictive.

---

## 7. Ruflo: solve the AI workforce problem

You don't have one agent. You have:

```
Planner · Architect · Coder · Tester · Security · Reviewer · Deployer · Researcher
```

The problem becomes: **who is allowed to do what?** Memnox becomes the IAM for the agent workforce.

```
AI WORKFORCE

Architecture Agent  → read code, write ADR
Coding Agent        → write source
Testing Agent       → run tests
Security Agent      → read infrastructure
Deployment Agent    → deploy staging
Production Agent    → deploy production
```

Each gets a role. Memnox enforces the boundaries.

---

## 8. Solve Ruflo's multi-agent collision problem

```
Agent A → refactoring checkout.ts
Agent B → fixing checkout.ts
Agent C → security audit checkout.ts
```

Memnox sees:

```
3 agents
1 repository
same files
conflicting write operations
```

Instead of waiting for Git conflicts, **Memnox locks `checkout.ts` for Agent A.** Agent B receives:

> `checkout.ts` is currently controlled by Agent A. You can read it, but cannot modify it.

That's the existing `memnox lock` idea becoming extremely practical. And this isn't merely security — it's **coordination infrastructure**.

---

## 9. Agent Rollback

```
Ruflo swarm → 183 file changes → PR created → production deployed → incident
```

Memnox has the complete action ledger. User clicks **Rewind agent activity**:

```
Agent:
Ruflo deployment swarm

Changes:
183 files
14 infrastructure changes
3 configuration changes

Restore to:
Before autonomous run

[REWIND]
```

More powerful than Git alone, because Memnox understands *which changes were caused by which agent execution*.

---

## 10. Agent Black Box

Every autonomous run gets a causal record — not `agent.log`, but:

```
RUN #8291

User intent:
"Fix checkout failures."

Agent:        Hermes
Sub-agent:    Claude Code

Reasoning path:
CI failure → checkout-service → dependency mismatch → package update

Actions:          47
Files changed:    8
Tests:            23
PR:               #1821
Deployment:       staging

Policy decisions:
46 ALLOW · 1 ASK · 0 DENY

Outcome: SUCCESS
```

Then the user can ask: *Why did the agent change this file? Why did it have permission? What did it touch? What would have happened if we hadn't stopped it?* — Memnox answers all four. Dramatically more useful than raw logs.

---

## 11. Combine agent behavior with organizational knowledge

This is where Memnox becomes much harder to replace.

OpenClaw receives: *"Deploy the latest version."* Technically it can. But Memnox knows:

```
Slack:     "Production frozen until Monday."
Linear:    INC-482 active.
GitHub:    PR not approved.
Calendar:  Release window closed.
```

**Memnox: DENIED** — *Production deployment is currently unauthorized because the release freeze is active.*

The killer distinction:

- Agent frameworks know: **Can I execute this?**
- Memnox knows: **Should this organization allow me to execute this right now?**

---

## 12. Ask Me Only When Necessary

Memnox shouldn't become an annoying approval popup machine. If an agent performs 1,832 actions, you don't want five hundred `Approve?` prompts.

Instead Memnox learns safe boundaries:

```
1,801 → automatic
   24 → automatic
    5 → grouped approval
    2 → blocked
```

> "I grouped 5 similar actions for approval."

One decision. This is how Memnox allows high autonomy without high interruption.

---

## 13. Autonomy Budget

Instead of only permissions, give agents budgets:

```
HERMES

LLM budget:      $25/day
External API:    500 calls/day
GitHub:          20 PRs/day
Production:      3 deployments/day
Database:        5,000 writes/day
Email:           50 outbound messages/day
```

If Hermes starts behaving abnormally and burns through it: **Agent budget exhausted.**

This directly addresses the "infinite token burn" problem and gives businesses financial predictability.

---

## 14. Agent Insurance (premium positioning)

Before enabling full autonomy:

```
MEMNOX

You are enabling:
Production access · Database writes · GitHub writes · AWS access

Potential blast radius: CRITICAL

Memnox protection:
✓ action interception
✓ rollback
✓ policy enforcement
✓ credential boundaries
✓ anomaly detection
✓ execution ledger

[ENABLE AUTOPILOT]
```

The emotional value: *"I'm willing to let my AI employee loose because Memnox is standing behind it."* Much more powerful than *"We have an AI security product."*

---

## 15. Daily Agent CFO

Especially for Ruflo. If someone runs hundreds of agents:

```
TODAY'S AI OPERATIONS

Agents:            47
LLM spend:         $83.42
Actions:           18,293
Successful:        17,912
Blocked:           281
Retries:           100
Estimated waste:   $11.37

Top expensive agent:  Ruflo / research swarm
Top waste source:     Repeated failed browser workflow

Recommended: Enable circuit breaker.
```

Now Memnox isn't only security. It's **AI operations economics** — and companies will pay for that.

---

## 16. "What should I automate next?"

The feature that could make Memnox genuinely addictive. Memnox observes behavior:

```
Hermes:    32 manual approvals for staging deployment
OpenClaw:  18 manual CRM updates
Ruflo:     12 manual test executions
```

Then:

```
AUTOMATION OPPORTUNITIES

1. Staging deployments
   32 repeated approvals
   Risk: Low
   Recommendation: Autonomous

2. CRM enrichment
   18 repeated approvals
   Risk: Low
   Recommendation: Autonomous

3. CI repair
   9 repeated approvals
   Risk: Medium
   Recommendation: Supervised
```

> "You could safely delegate ~6.4 hours/week based on your current approval history."

That is a fantastic product loop.

---

## 17. Three agents, three Memnox experiences

### Hermes — *"Let Hermes work overnight."*

- circuit breaker
- skill-change quarantine
- token budget
- overnight mode
- capability drift
- recovery
- causal audit

### OpenClaw — *"Turn OpenClaw into a safe digital employee."*

- identity
- delegation levels
- messaging permissions
- external communication controls
- financial boundaries
- personal-data boundaries
- progressive autonomy

### Ruflo — *"Run an AI engineering workforce without losing control."*

- agent identity
- role-based authority
- swarm-wide policy
- file locks
- cross-agent conflict detection
- production gates
- action ledger
- cost budgets
- rollback

---

## 18. All three converge into one product

```
                    MEMNOX
                       │
       ┌───────────────┼────────────────┐
       │               │                │
     HERMES         OPENCLAW          RUFLO
       │               │                │
  autonomous        personal/         multi-agent
    worker          business OS        workforce
       │               │                │
       └───────────────┼────────────────┘
                       │
                 MEMNOX CONTROL
                       │
       ┌───────────────┼─────────────────┐
       │               │                 │
    Identity        Policy            Context
       │               │                 │
    Authority        Risk             Intent
       │               │                 │
       └───────────────┼─────────────────┘
                       │
                 REAL ACTIONS
```

The product category:

> **Memnox = Control Plane for Autonomous Work**

Not another agent. Not another orchestration framework. Not another memory system. Not another SIEM. Not merely AI security.

---

## 19. The "pay for it" ladder

Structure the value around **how much autonomy you want to unlock**, rather than number of dashboards.

### Free — *See*

```
Scan
Explain
Agent inventory
Capabilities
Basic risk
```

Hook: *"Holy shit, my agent can do THAT?"*

### Pro — ~$29–49 — *Control*

```
Runtime enforcement
Approval workflows
Circuit breakers
Budgets
Capability drift
Action history
```

Hook: *"Now I can safely leave it running."*

### Team — ~$99–299 — *Delegate*

```
Multiple agents
Multiple VPSs
Hermes / OpenClaw / Ruflo
Cross-agent policy
Agent locks
Shared organizational context
Rollback
Trust scores
```

Hook: *"My team can run an AI workforce."*

### Enterprise — *Govern*

```
Agent IAM
SSO/RBAC
Production controls
Audit
Compliance
Data boundaries
Policy-as-code
Fleet management
```

Hook: *"We can actually allow autonomous AI inside production."*

---

## 20. The most important change to the original vision

Don't make **"What did my agent do?"** the primary experience.

Make **"What can I safely let my agent do next?"** the primary experience.

Then Memnox continuously moves the customer through:

```
              DON'T TRUST IT
                    │
                    ▼
                 OBSERVE
                    │
                    ▼
                 CONTROL
                    │
                    ▼
                  TRUST
                    │
                    ▼
               DELEGATE MORE
                    │
                    ▼
                AUTOMATE MORE
                    │
                    ▼
                ADD AGENTS
                    │
                    ▼
             RUN AI WORKFORCE
                    │
                    ▼
             MEMNOX IS CRITICAL
```

That is the addiction loop. The user doesn't pay Memnox because they enjoy security. They pay because **Memnox lets them safely give their agents more responsibility.**

And the ultimate Memnox notification shouldn't be:

> ⚠️ Agent blocked.

It should sometimes be:

> 🤖 Your agents completed 47 tasks overnight. Nothing required your attention.

That is the outcome you're selling.

---

---

# Part II — Local agents (Claude Code, Codex, Cursor…)

Local agents may actually be the **strongest wedge** for Memnox.

The important distinction: Memnox should not try to replace their local permission systems. Claude Code already has permissions, hooks, and OS-level sandboxing; Codex has approval modes and sandbox boundaries.

Instead: **Memnox becomes the control plane above all local agents.**

---

## The local-agent problem

Imagine your laptop has:

```
Claude Code · Codex · Cursor · OpenCode · Aider
```

Each one has its own permissions, MCP servers, credentials, filesystem access, network access, approval rules, hooks, sandbox, configuration, and agent sessions.

Your machine doesn't have **one unified policy** for all of them.

Claude may be allowed to access:

```
~/projects/*
~/.aws/*
github.com
npmjs.org
```

while Codex has a different sandbox, and Cursor has another set of MCPs. So you end up with **five agents × five security models × five configurations.**

---

## Memnox for local agents

```
                 MEMNOX
          ┌──────────────────┐
          │ Global Policy    │
          │ Risk Engine      │
          │ Action Ledger    │
          │ Agent Identity   │
          │ Trust Score      │
          └────────┬─────────┘
                   │
       ┌───────────┼────────────┐
       ↓           ↓            ↓
   Claude Code   Codex       Cursor
       │           │            │
       └───────────┼────────────┘
                   ↓
            Local Machine
                   │
       ┌───────────┼────────────┐
       ↓           ↓            ↓
   filesystem    network      MCP/tools
       │           │            │
       └───────────┼────────────┘
                   ↓
             Real systems
```

Memnox doesn't care whether the agent is Claude, Codex, Cursor or something else. It cares about: **"What is this agent trying to do, and should it be allowed to do it?"**

---

## 1. One command to see everything

```
memnox scan
```

```
AI AGENTS ON THIS MACHINE

Claude Code
  Risk: HIGH
  MCP servers: 7
  Filesystem: 14 directories
  Network: 23 domains
  Credentials detected: 4
  Shell: YES
  Git: YES
  Docker: YES

Codex
  Risk: MEDIUM
  MCP servers: 3
  Filesystem: workspace
  Network: restricted
  Shell: YES

Cursor
  Risk: HIGH
  MCP servers: 9
  Filesystem: 31 directories
  Network: unrestricted

────────────────────────────────

Effective capabilities

Claude + AWS credentials + kubectl
→ CAN potentially modify production

Claude + GitHub + filesystem
→ CAN modify repositories

Cursor + Slack MCP + GitHub MCP
→ CAN read organizational communication
   and modify source code
```

Much more valuable than simply showing Claude's configuration.

---

## 2. The killer feature: effective capability

Don't just say `Claude has access to AWS.` Say:

```
Claude has:

AWS credentials
+ kubectl
+ production kubeconfig
+ network access
+ shell execution

Therefore:

⚠️ EFFECTIVE CAPABILITY
Can modify production Kubernetes resources.
```

Or:

```
Claude

GitHub write
+ Slack read
+ filesystem read
+ internet access

Potential capability:

⚠️ Read internal information → package it → send externally
```

Much more powerful than conventional permission inspection.

---

## 3. `memnox protect`

```
memnox protect claude
```

```
I found 4 high-risk capabilities.

1. Production AWS credentials
2. ~/.ssh access
3. unrestricted network
4. Docker socket

Recommended:

✓ Remove ~/.ssh access
✓ Block Docker socket
✓ Restrict network
✓ Remove production credentials
✓ Keep GitHub + development AWS

Apply?
```

```
✓ Protected Claude Code

Claude can still:
  ✓ modify your repositories
  ✓ run tests
  ✓ install packages
  ✓ access GitHub

Claude can no longer:
  ✗ access production
  ✗ access SSH keys
  ✗ access Docker daemon
  ✗ communicate with arbitrary domains
```

---

## 4. The really valuable part is runtime

You run `claude`. Claude decides:

```
aws s3 cp customer.csv s3://external-bucket
```

The user might never have explicitly configured that exact scenario. Memnox intercepts:

```
Claude Code → tool/action → Memnox → policy evaluation → ALLOW / ASK / DENY
```

```
🚨 BLOCKED

Claude Code attempted:
aws s3 cp customer.csv s3://external-bucket

Why?
• customer.csv contains customer data
• destination is external
• current project policy forbids external data transfer
• agent has no approved export task

Decision: DENY
```

---

## 5. Don't make users approve everything

Otherwise Memnox becomes another annoying permission popup. Memnox should learn autonomy.

**First day:**

```
npm install     → ALLOW
git commit      → ALLOW
git push        → ASK
terraform apply → DENY
```

**After observing behavior:**

```
Trust profile: Claude Code / project-x

npm install        → automatic
tests              → automatic
git commits        → automatic
git push           → automatic
production deploy  → approval required
database migration → approval required
external upload    → blocked
```

Now the user isn't babysitting the agent.

---

## 6. The addictive loop

```
              Agent wants to act
                     ↓
                 Memnox
                     ↓
           ┌─────────┼─────────┐
           ↓         ↓         ↓
         ALLOW      ASK       DENY
           ↓         ↓         ↓
       executes   user       blocked
                   decides
           ↓
       learn from action
           ↓
       increase autonomy
```

The user gradually moves from *"I have to watch Claude"* to *"Claude can work without me."* That's the thing people will pay for.

---

## 7. `memnox watch`

```
memnox watch
```

```
06:31 Claude Code started

06:32 Read 48 files
06:34 Executed npm test
06:36 Installed package
06:38 Modified auth.ts
06:41 Called GitHub API
06:44 Started Docker container
06:47 Attempted access to ~/.ssh
      ↳ BLOCKED

06:48 Attempted outbound request to unknown domain
      ↳ BLOCKED
```

You get an agent black box. Not *"Claude says it completed the task"* but **here is exactly what Claude did.**

---

## 8. `memnox why`

**Agent:** "Why can't I access production?"

**Memnox:**

```
Because:

1. Your production environment is currently frozen.
2. The deployment has no approved PR.
3. An active incident exists.
4. Your policy requires human approval for production changes.

Decision: DENY
```

This is where the organizational-memory vision becomes powerful. The local agent may technically possess the credentials. But **technical capability ≠ authorization.**

---

## 9. Cross-agent protection

Something Claude Code itself cannot really solve globally:

```
Claude Code → working on auth.ts
Codex       → working on auth.ts
Cursor      → working on auth.ts
```

```
⚠️ CONFLICT

Claude Code is modifying: src/auth.ts
Codex is modifying:       src/auth.ts
Cursor is modifying:      src/auth.ts

Risk: concurrent modifications may overwrite each other's work.
```

```
memnox lock src/auth.ts
```

Memnox coordinates the agents. That starts turning Memnox into **the operating system for an AI workforce.**

---

## 10. The biggest local-agent opportunity: two layers

### Local Memnox — free / OSS

```
Your machine

Claude · Codex · Cursor · OpenCode · Aider
        ↓
     Memnox
        ↓
filesystem · shell · network · MCP · Docker · Git · credentials
```

### Memnox Cloud

```
                 Memnox Cloud

        Organization Policy
                │
        Agent Identity
                │
        Global Agent Fleet
                │
        Decision Graph
                │
        Action Ledger
                │
        Organizational Memory
                │
       ┌────────┼─────────┐
       ↓        ↓         ↓
    Laptop    VPS       CI/CD
       ↓        ↓         ↓
    Claude   Hermes    Ruflo
    Codex    OpenClaw  Swarms
```

The cloud isn't just a dashboard. It becomes the **global control plane** for all local and remote agents.

---

## And this changes the pricing strategy

**Free OSS:**

```
memnox scan
memnox explain
memnox protect
basic local policies
basic local action history
```

**Paid ($29+):**

```
Cross-agent policy
Runtime enforcement
Agent trust
Long-term history
Cloud synchronization
Organization policies
Remote agents
Agent fleet
Approval workflows
Audit trail
Autonomy budgets
Rollback
Organizational context
```

So the user isn't paying because *"Memnox protects my Claude Code."* They're paying because:

> **"Memnox lets me run 10 agents without having to supervise 10 agents."**

A much stronger willingness-to-pay story.

Importantly: Claude Code already has sophisticated local permissions/hooks/sandboxing, and Codex already has local approval modes and sandboxing — so Memnox should position itself as the **unifying policy and execution layer across agents**, not as a replacement for those mechanisms.

---

## Taglines for this wedge

> **Your agents run locally. Their authority shouldn't be local.**

Or more directly:

> **One control plane for every AI agent on your machine.**
