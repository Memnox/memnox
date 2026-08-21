# The Memnox vision

The architecture this project is built toward. `ARCHITECTURE.md` describes what
the runtime is today; this describes what the whole of Memnox is for, across the
open runtime and the cloud control plane. Where the two disagree, this document
is the intent and `ARCHITECTURE.md` is the state.

If we take the whole Memnox vision seriously, not just "memory for AI agents", it
is an open-source organizational runtime plus a cloud control plane.

The key is to avoid building another Viktor, another connector marketplace, or
another generic RAG system.

The core thing Memnox owns is:

> The machine-readable operating model of an organization: what it knows, who
> can know it, who can do what, why, and what should happen next.

That gives a clean separation between the open-source infrastructure anyone can
run and the cloud product companies pay for.

---

## 1. The complete Memnox architecture

At the highest level:

```
                         ORGANIZATION
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
        HUMANS             AI WORKERS          SYSTEMS
          │                   │                   │
      Employees          Viktor / Lindy       Slack
      Managers           Claude agents        GitHub
      Executives         Copilot              Jira
      Customers          Custom agents        Salesforce
          │                   │                   │
          └───────────────────┼───────────────────┘
                              │
                              ▼
                    ┌───────────────────┐
                    │      MEMNOX       │
                    │                   │
                    │ ORGANIZATIONAL    │
                    │     RUNTIME       │
                    └───────────────────┘
                              │
       ┌──────────────────────┼────────────────────────┐
       │                      │                        │
       ▼                      ▼                        ▼
 ORGANIZATIONAL          GOVERNANCE              EXECUTION
    CONTEXT               & TRUST                 CONTROL
       │                      │                        │
       ▼                      ▼                        ▼
 Knowledge Graph          Identity                Action Gateway
 Decision Graph           Permissions             Policy Engine
 Memory                   Policies                Approvals
 Relationships            Classification          Delegation
 Ownership                Risk                    Verification
 History                  Constraints              Audit Ledger
       │                      │                        │
       └──────────────────────┼────────────────────────┘
                              │
                              ▼
                    COMPANY SYSTEMS / APIs
```

The important thing is that Memnox is not necessarily in the middle of every
network request.

It can operate in three modes:

1. **Context mode.** Agent asks Memnox what it should know.
2. **Governance mode.** Agent asks Memnox whether it is allowed to do something.
3. **Enforcement mode.** Memnox actually sits in the execution path and blocks or
   allows actions.

That is extremely important for adoption.

---

## 2. Two products, one architecture

Memnox divides explicitly:

```
                 MEMNOX
                    │
          ┌─────────┴─────────┐
          │                   │
      OPEN SOURCE            CLOUD
       RUNTIME             PLATFORM
          │                   │
    Self-hostable         Memnox Cloud
    Apache-2.0            Managed
          │                   │
      Developers          Organizations
      Platforms           Enterprises
      AI companies        AI teams
```

The mistake would be making the OSS version a crippled demo.

Instead: the runtime is genuinely useful and fully capable. The cloud sells
coordination, scale, management, collaboration, observability, enterprise
security and convenience.

---

## 3. What belongs in open source

The core runtime is Apache-2.0:

```
memnox/
│
├── runtime/
├── sdk/
├── agent-sdk/
├── policy-engine/
├── context-engine/
├── decision-engine/
├── identity/
├── ledger/
├── local-storage/
├── MCP server/
├── API server/
├── connector SDK/
└── CLI
```

The OSS runtime should allow:

```
npx memnox setup
```

and give a developer:

```
Agent
  ↓
Memnox
  ├── context
  ├── policies
  ├── identity
  ├── approvals
  ├── decisions
  └── audit
```

without needing Memnox Cloud. That is the developer adoption engine.

---

## 4. The cloud should not just be "hosted Memnox"

This is where the commercial moat appears.

```
                  MEMNOX CLOUD
                       │
       ┌───────────────┼────────────────┐
       │               │                │
 Organization       AI Fleet         Governance
   Management       Management        Center
       │               │                │
       ▼               ▼                ▼
 Teams              Agents            Policies
 Users              Capabilities      Approvals
 Sources            Identity          Audit
 Projects           Usage             Compliance
```

Cloud features: organization management, team management, agent registry,
centralized policies, shared organizational graph, cross-agent context, approval
workflows, audit, compliance exports, analytics, fleet management, policy
distribution, managed connectors, managed event ingestion, SSO and SAML,
enterprise isolation, backups, retention, monitoring, billing, support.

So: **OSS is the organizational runtime. Cloud is the organizational control
plane.**

---

## 5. The first major component: Organization Graph

One of Memnox's deepest assets. Not `documents → embeddings → vector search`.

```
                     ORGANIZATION GRAPH

                          ACME
                           │
       ┌───────────────────┼──────────────────┐
       │                   │                  │
     People              Teams             Agents
       │                   │                  │
   ┌───┴───┐          ┌────┴────┐       ┌────┴────┐
   │       │          │         │       │         │
 Alice    Bob       Finance   Eng     Viktor   Claude
   │                   │         │       │
   ▼                   ▼         ▼       ▼
Projects             Policies   GitHub  Salesforce
```

**Entities:** Organization, Person, Team, Agent, Application, Project,
Repository, Customer, Resource, Document, Decision, Policy, Workflow, Role,
Permission, Task, Incident, Meeting, Conversation.

**Relationships:** `reports_to`, `member_of`, `owns`, `created_by`,
`approved_by`, `responsible_for`, `works_on`, `uses`, `can_access`,
`cannot_access`, `depends_on`, `replaces`, `supersedes`, `derived_from`,
`decided_by`, `applies_to`, `delegated_to`.

This is much more defensible than a vector database.

---

## 6. The Decision Graph

Its own layer. Memnox converts organizational events into structured decisions.

```json
{
  "decision_id": "dec_481",
  "statement": "Use Stripe for European payments",
  "status": "active",
  "owner": "finance",
  "approved_by": ["cfo"],
  "scope": { "region": "EU", "system": "payments" },
  "created_at": "...",
  "sources": ["slack:message_123", "meeting:456"]
}
```

But importantly:

```
Decision
   │
   ├── evidence
   ├── owner
   ├── approver
   ├── scope
   ├── expiration
   ├── exceptions
   ├── supersedes
   └── consequences
```

Now an agent asking "What payment provider should I use?" is not retrieving a
document. Memnox answers with the decision, the reason, the scope, the status,
the confidence, the authority and the exceptions.

That is organizational memory becoming machine-readable organizational state.

---

## 7. Memory architecture

Not one giant memory store. Multiple memory types.

```
                    MEMNOX MEMORY
                         │
       ┌─────────────────┼─────────────────┐
       │                 │                 │
    Episodic          Semantic          Structural
       │                 │                 │
 conversations        knowledge         relationships
 events               concepts          ownership
 meetings             facts             hierarchy
       │                 │                 │
       └─────────────────┼─────────────────┘
                         │
                    Decision Memory
                         │
                   organizational
                      decisions
```

Technically: event store, document store, relational metadata, graph, vector
index. The vector database is only one component.

---

## 8. The ingestion architecture

Where Memnox actually gets the organization's knowledge. Four ingestion paths.

```
                 MEMNOX INGESTION
                       │
       ┌───────────────┼────────────────┐
       │               │                │
 Direct connectors   Agent APIs       SDK/events
       │               │                │
 Slack              Viktor            Custom app
 GitHub             Lindy             Backend
 Notion             Agentforce        Agent SDK
 Jira               Custom agent      Webhooks
       │               │                │
       └───────────────┼────────────────┘
                       │
                       ▼
                 Event Gateway
                       │
                       ▼
                 Normalization
                       │
                       ▼
                Entity Resolution
                       │
                       ▼
                Knowledge Engine
```

This means no customer is forced to connect their tools to Memnox.

---

## 9. The Viktor scenario

Viktor already has 3000+ connectors. Do not rebuild those.

```
                   ACME
                    │
             ┌──────┴──────┐
             │             │
          Viktor         Memnox
             │             │
       3000+ tools       Org Graph
             │             │
             └──────┬──────┘
                    │
             Memnox integration
```

Viktor sends Memnox: agent identity, user identity, workspace or team, task,
tool invocation, resource, action, result, audit event. Memnox learns from those
events.

---

## 10. Viktor plus Memnox, technically

```
Viktor
  │
  ├── API
  ├── MCP
  ├── webhooks/events
  └── SDK
        │
        ▼
   Memnox Adapter
        │
        ▼
   Memnox Runtime
```

```ts
const decision = await memnox.authorize({
  actor: "viktor-agent",
  user: "user_123",
  action: "send_email",
  resource: "customer_456",
  context: { amount: 4500 },
});
```

```json
{
  "decision": "approval_required",
  "policy": "finance.external_communication",
  "approver": "finance_manager"
}
```

Viktor remains responsible for doing the work. Memnox is responsible for
organizational authority. That is the boundary.

---

## 11. MCP becomes an important interface

```
memnox.get_context()
memnox.search_knowledge()
memnox.get_decision()
memnox.get_policy()
memnox.get_owner()
memnox.check_permission()
memnox.authorize_action()
memnox.request_approval()
memnox.delegate()
memnox.record_decision()
```

But do not rely exclusively on MCP. Also: REST API, SDKs, webhooks, events, MCP,
CLI.

---

## 12. The Context Gateway

The brain's retrieval interface. An agent asks: "I need to prepare a pricing
proposal."

Memnox determines who is asking, what agent, which user, which team, which
project, what the task is, what information is relevant, what is restricted,
what decisions apply and what policies apply.

```
                 CONTEXT REQUEST
                        │
                        ▼
                  Identity check
                        │
                        ▼
                  Scope resolution
                        │
                        ▼
                 Policy evaluation
                        │
                        ▼
                  Retrieval
                        │
                        ▼
                  Re-ranking
                        │
                        ▼
                Context assembly
                        │
                        ▼
                     Agent
```

Far more powerful than `agent → vector DB → documents`.

---

## 13. Context should be permission-aware BEFORE retrieval

Do not do:

```
retrieve everything
      ↓
filter afterwards
```

Do:

```
identity
   ↓
authorization
   ↓
eligible knowledge
   ↓
retrieval
   ↓
context
```

That minimizes accidental exposure.

---

## 14. The Policy Engine

Deterministic wherever possible.

```
Finance agents may:        read invoices
Finance agents may not:    approve refunds > $1,000
Finance managers may:      approve refunds ≤ $10,000
CFO may:                   approve any refund
```

A policy language of `subject`, `action`, `resource`, `conditions`, `effect`:

```
ALLOW
  subject = finance_manager
  action = approve_refund
  amount <= 10000

DENY
  subject = finance_agent
  action = approve_refund
```

The LLM can interpret intent. The policy engine makes the final deterministic
decision.

---

## 15. The Action Gateway

Where Memnox moves from memory to execution trust.

```
Agent
  │ wants to act
  ▼
Memnox Action Gateway
  │
  ├── Identity
  ├── Authorization
  ├── Policy
  ├── Context
  ├── Risk
  ├── Approval
  └── Verification
        │
        ▼
     ALLOW
        │
        ▼
External system
```

```
Viktor → refund $4,500 → Memnox
  → policy: > $1,000 requires approval
  → HOLD → Finance manager → APPROVE
  → Viktor → Stripe
```

---

## 16. Risk engine

Not every action needs the same treatment.

```
LOW       └── read public information
MEDIUM    └── create internal task
HIGH      ├── send external email
          ├── modify production data
          └── change customer records
CRITICAL  ├── transfer money
          ├── delete production data
          ├── change security configuration
          └── expose restricted information
```

Then policies can say:

```
LOW       → automatic
MEDIUM    → automatic + logging
HIGH      → policy evaluation
CRITICAL  → human approval
```

---

## 17. Verification engine

Do not simply ask "Is this allowed?" Ask "Did the action actually achieve what
was authorized?"

Agent says "delete customer record", Memnox denies. Agent says "update customer
email", Memnox allows, execution succeeds, and then verification asks: did the
email actually change, did the audit event arrive, is the database state
consistent?

```
Intent
 ↓
Authorization
 ↓
Execution
 ↓
Verification
 ↓
Ledger
```

---

## 18. Human approval system

Approvals are a first-class primitive.

```
Agent → Memnox → Approval required
  → Slack / Teams / Dashboard → Human → Approve
  → Memnox → Agent
```

The approval object contains: who requested, what action, which resource, why,
policy triggered, risk, context, proposed action, expiration, approver, decision,
timestamp. This becomes part of the organizational memory.

---

## 19. Delegation

Agents should not only ask "Can I do this?" They should ask "Who should do this?"

```
Viktor Finance Agent
       │ can't approve $20k
       ▼
Memnox
       │ responsibility graph
       ▼
Finance Director
       ▼
Approval
```

Memnox knows who owns it, who can approve it, who is responsible, who is
unavailable and who can substitute. That is organizational intelligence.

---

## 20. Agent registry

Every organization should have an AI workforce registry.

```
AGENTS

Viktor Finance
    owner: CFO
    team: Finance
    capabilities: invoices, CRM, email
    risk: high

Claude Coding Agent
    owner: CTO
    team: Engineering
    capabilities: GitHub, Jira
    risk: high

Customer Support Agent
    owner: Support
    capabilities: CRM, email, knowledge base
```

---

## 21. Human plus AI organizational graph

```
                 ORGANIZATION
                      │
          ┌───────────┴───────────┐
          │                       │
        HUMAN                    AI
          │                       │
    ┌─────┼─────┐          ┌──────┼──────┐
    │     │     │          │      │      │
   CEO   CFO   CTO       Viktor  Claude  Custom
    │     │     │          │      │
    └─────┴─────┴──────────┴──────┘
                      │
                  MEMNOX GRAPH
```

This is where the vision becomes much larger than AI governance.

---

## 22. Organizational learning loop

The moat to focus on. Every action creates information.

```
Agent action → Policy decision → Human response
  → Execution result → Outcome
  → Memnox learns → Organizational graph updated
```

```
Agent repeatedly requests approval
  → Manager always approves
  → Memnox detects pattern
  → Suggest policy change
  → Human approves policy
  → Future requests become automatic
```

The organization becomes increasingly machine-readable.

---

## 23. The Organizational Twin

The internal name for the concept. Memnox maintains a continuously updated
representation of: WHO, WHAT, WHY, WHERE, WHEN, WHO OWNS IT, WHO CAN ACCESS IT,
WHO CAN CHANGE IT, WHAT HAS BEEN DECIDED, WHAT IS ALLOWED, WHAT IS HAPPENING,
WHAT SHOULD HAPPEN.

That is the core intellectual property.

---

## 24. Data pipeline

```
Source
  ▼
Connector / Adapter
  ▼
Event Gateway
  ▼
Normalizer
  ▼
Entity Resolver
  ▼
Classifier
  ├──────────────┐
  ▼              ▼
Knowledge      Event Store
  ▼              ▼
Graph          Timeline
  └──────┬───────┘
         ▼
    Decision Engine
         ▼
    Policy Engine
         ▼
    Context Engine
```

---

## 25. The ingestion layer should be pluggable

Do not hardcode the business around six connectors.

```ts
interface MemnoxSource {
  authenticate(): Promise<void>;
  sync(): AsyncIterable<MemnoxEvent>;
  subscribe?(): AsyncIterable<MemnoxEvent>;
  capabilities(): SourceCapabilities;
}
```

Slack, GitHub, Notion, Jira, Viktor, Salesforce and custom adapters. The OSS SDK
lets other companies build their own. That matters enormously.

---

## 26. AI-agent adapter architecture

```ts
interface AgentAdapter {
  identify(): AgentIdentity;
  observe(event): Promise<void>;
  getContext(request): Promise<Context>;
  authorize(action): Promise<Decision>;
  reportResult(result): Promise<void>;
}
```

`ViktorAdapter`, `LindyAdapter`, `CustomAgentAdapter`, `LangGraphAdapter`,
`OpenAIAgentAdapter`, `MCPAdapter`.

You do not need to control the agent. You become the organizational interface.

---

## 27. Three deployment models

**A. Embedded.** An AI company embeds Memnox into its own product.

```
Viktor
 └── Memnox SDK
       └── customer's organization
```

**B. Sidecar.** Useful for enterprises.

```
Agent
 ├── Memnox sidecar
 └── tools
```

**C. Gateway.** Useful when you need enforcement.

```
Agent → Memnox → Tools
```

Memnox should support all three eventually.

---

## 28. OSS architecture

```
                    memnox runtime
                          │
       ┌──────────────────┼──────────────────┐
       │                  │                  │
     API                 SDK                MCP
       │                  │                  │
       └──────────────────┼──────────────────┘
                          │
                   Runtime Core
                          │
        ┌─────────────────┼─────────────────┐
        │                 │                 │
    Identity          Context            Policy
        │                 │                 │
        ├──────────── Decision ─────────────┤
        │                 │                 │
     Actions          Approvals           Ledger
        │                 │                 │
        └─────────────────┼─────────────────┘
                          │
                    Storage Layer
                          │
       ┌──────────────────┼─────────────────┐
       │                  │                 │
    SQLite/Postgres      Graph            Vector
```

Local development: SQLite, embedded vector index, local graph, filesystem.
Production: Postgres, pgvector, graph storage, object storage, event stream. The
interfaces stay identical.

---

## 29. Cloud architecture

```
                         MEMNOX CLOUD
                              │
                     Global Control Plane
                              │
       ┌──────────────────────┼─────────────────────┐
       │                      │                     │
 Organization API       Agent Management       Billing
       │                      │                     │
       └──────────────────────┼─────────────────────┘
                              │
                       Tenant Control Plane
                              │
       ┌──────────────────────┼─────────────────────┐
       │                      │                     │
    Ingestion             Governance            Analytics
       │                      │                     │
       ▼                      ▼                     ▼
 Connectors                Policies             Usage
 Events                    Approvals             Risk
 Sync                      Identity              Audit
       │                      │
       └──────────────┬───────┘
                      ▼
                 Org Runtime
                      │
          ┌───────────┼───────────┐
          ▼           ▼           ▼
        Graph      Memory       Ledger
```

---

## 30. The cloud should manage, not necessarily execute everything

```
Customer infrastructure

       Memnox Runtime
             │ telemetry / config
             ▼
       Memnox Cloud
```

The enterprise story: your sensitive organizational data can remain in your
environment while Memnox Cloud manages policies, configuration and fleet
operations.

---

## 31. Privacy architecture

Every fact should have metadata: `tenant_id`, `source`, `classification`,
`owner`, `scope`, `created_at`, `expires_at`, `retention_policy`,
`allowed_principals`, `provenance`, `confidence`.

```json
{
  "fact": "Company is considering acquisition X",
  "classification": "restricted",
  "scope": ["executive"],
  "allowed_agents": [],
  "source": "board_meeting_92"
}
```

The agent should not even know that the fact exists unless authorized.

---

## 32. Provenance is critical

Every piece of knowledge answers: where did this come from?

```
Fact
 ├── Slack message
 ├── meeting transcript
 ├── Notion document
 └── human confirmation
```

```
Decision #481
confidence = high
authority = CFO
evidence = 4 sources
```

This prevents Memnox from becoming an untrustworthy AI-generated knowledge base.

---

## 33. Contradiction engine

Organizations constantly contradict themselves. Notion says use PostgreSQL, Slack
says we decided to migrate to MongoDB, GitHub has a MongoDB implementation.

```
CONFLICT

Old decision:                PostgreSQL
New evidence:                MongoDB
Likely superseding decision: Slack message #123
Status:                      Needs confirmation
```

A very valuable organizational intelligence feature.

---

## 34. Temporal memory

The organization changes.

```
Decision A   2025 → active
Decision B   2026 → supersedes A
```

Do not overwrite history. Store `valid_from`, `valid_until`, `supersedes`,
`superseded_by`. Then agents can ask "What is our current policy?" or "Why did we
choose this?" and both work.

---

## 35. The action ledger

Every governed action becomes:

```
Action
 ├── actor
 ├── human principal
 ├── organization
 ├── requested action
 ├── resource
 ├── policy evaluated
 ├── context used
 ├── decision
 ├── approval
 ├── execution
 ├── verification
 └── outcome
```

Extremely valuable for security, compliance, debugging, incident investigation
and enterprise trust.

---

## 36. What the dashboard becomes

There are two UIs.

**The agent and company dashboard**, for organizations using Memnox directly:

```
Overview

AI Workforce   12 agents
Policies       48 active
Approvals      7 pending
Decisions      1,842
Risk           3 high-risk agents
Activity       12,421 governed actions
```

**The embedded and API experience**, for AI companies like Viktor:

```
Viktor UI
     └── Memnox operates invisibly
```

Viktor can surface "Governed by Memnox" without requiring customers to leave
Viktor.

---

## 37. The developer experience

```
npm install @memnox/sdk
```

```ts
const memnox = new Memnox({ organization: "acme" });

const context = await memnox.context({ task: "prepare customer proposal" });

const decision = await memnox.authorize({
  action: "send_email",
  resource: customer,
});

await memnox.approval.request({ action: "refund", amount: 4500 });

await memnox.actions.record(result);
```

That should take minutes to integrate.

---

## 38. The open-source moat

The OSS part should not try to be the entire commercial business.

```
Open source
     ↓
Developers
     ↓
AI companies
     ↓
Agents integrate Memnox
     ↓
Organizations adopt it
     ↓
Organizations need centralized management
     ↓
Memnox Cloud
```

Because the runtime is open, AI companies can trust that Memnox is not a black
box sitting between their agents and their customers. That is strategically
useful.

---

## 39. What you should NOT build

- Another AI employee. Viktor, Lindy and others already do this.
- Another 3,000-connector platform. Let the agent platforms own that.
- Another generic RAG platform. Too commoditized.
- Another vector database. Not the moat.
- Another SIEM. Not the core.
- Another IAM system. Integrate with existing identity systems.
- Another workflow automation platform. Do not compete with Zapier or ServiceNow.

Instead: Memnox understands organizational authority and context across them.

---

## 40. The strategic boundary

| Layer | Who owns it |
| --- | --- |
| AI model | OpenAI, Anthropic, others |
| AI employee | Viktor, Lindy, custom |
| Tools | Salesforce, Slack, GitHub, others |
| Identity provider | Okta, Microsoft, Google |
| Workflow | ServiceNow, Jira, others |
| Organization model | **Memnox** |
| AI authority | **Memnox** |
| Cross-agent context | **Memnox** |
| Decision memory | **Memnox** |
| Agent-to-organization governance | **Memnox** |

That is the territory.

---

## 41. The real Memnox architecture in one picture

```
                         ┌───────────────────────┐
                         │      ORGANIZATION      │
                         └───────────┬───────────┘
                                     │
               ┌─────────────────────┼─────────────────────┐
               │                     │                     │
            PEOPLE               AI WORKERS             SYSTEMS
               │                     │                     │
               │              ┌──────┼──────┐              │
               │              │      │      │              │
               │            Viktor Claude Custom            │
               │              │      │      │              │
               └──────────────┼──────┼──────┼──────────────┘
                              │      │      │
                              ▼      ▼      ▼
                       ┌──────────────────────┐
                       │       MEMNOX         │
                       │                      │
                       │ ORGANIZATIONAL       │
                       │      RUNTIME         │
                       └──────────┬───────────┘
                                  │
          ┌───────────────────────┼────────────────────────┐
          │                       │                        │
          ▼                       ▼                        ▼
   ORGANIZATIONAL             GOVERNANCE              EXECUTION
       MODEL                    MODEL                    MODEL
          │                       │                        │
      Org Graph               Identity                 Actions
      Knowledge               Roles                    Policies
      Decisions               Permissions               Risk
      Relationships           Classification            Approval
      Ownership               Constraints               Delegation
      History                 Authority                 Verification
          │                       │                        │
          └───────────────────────┼────────────────────────┘
                                  │
                                  ▼
                           ACTION / CONTEXT
                              GATEWAY
                                  │
                     ┌────────────┼────────────┐
                     │            │            │
                  MCP/API       SDK        Sidecar
                     │            │            │
                     └────────────┼────────────┘
                                  │
                                  ▼
                           COMPANY SYSTEMS
```

---

## 42. And then the Cloud

```
                         MEMNOX CLOUD
                              │
              ┌───────────────┼────────────────┐
              │               │                │
        Org Management    Agent Fleet      Governance
              │               │                │
        Users / Teams       Agents           Policies
        Projects            Identity         Approvals
        Sources             Capabilities     Audit
              │               │                │
              └───────────────┼────────────────┘
                              │
                        Control Plane
                              │
              ┌───────────────┼────────────────┐
              │               │                │
          Managed          Analytics        Enterprise
         Connectors          Risk           Security
              │               │                │
              └───────────────┼────────────────┘
                              │
                              ▼
                     CUSTOMER RUNTIMES
```

---

## 43. The ultimate product

If this architecture works, the product is not "connect Slack and GitHub and ask
questions."

It becomes:

> Every AI working for your company operates with the same understanding of the
> organization, and within the authority the organization gives it.

An AI agent can ask, and Memnox answers:

- What should I know?
- Am I allowed to know this?
- Am I allowed to do this?
- Who should approve this?
- Who owns this?
- Why do we do it this way?
- What happened the last time?
- What should happen next? (Memnox can help determine this.)

And if the agent acts:

```
Intent
  ↓
Context
  ↓
Authority
  ↓
Policy
  ↓
Approval
  ↓
Execution
  ↓
Verification
  ↓
Memory
```

That loop is Memnox.
