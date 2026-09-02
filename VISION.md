# The Memnox gap

Memnox closes the gap between what AI agents can do, what they actually do, and what your
organization intended them to do.

This is the vision. `ARCHITECTURE.md` describes what the runtime is today; this describes
the intent, and where the two disagree this is the intent. It lives in this repository
because this repository is version controlled.

It is not a feature list. Every entry is a painful situation happening in somebody's week
right now, why the tools they already have do not close it, what Memnox does about it, and
what they actually get. Sixty of them, in the order they were written down, because that
order turned out to be the order they get solved in: one machine, then a team, then a fleet,
then the instant an action is about to happen.

Shapes are proposals. The outputs shown are illustrative, not captured. Inside them, text
between guillemets is an annotation rather than something the tool prints.

---

## The core problem

AI agents can now read repositories, change code, run commands, open and close issues,
message people, reach databases, call APIs, deploy services, touch cloud infrastructure,
speak through MCP servers, and do all of it for hours with nobody watching:

```
reading repositories        calling APIs
modifying code              deploying services
executing commands          touching cloud infra
opening and closing issues  speaking through MCP
sending messages            running for hours
reaching databases          with nobody watching
```

What has not arrived alongside that is any way to hold three separate truths in one place:

```
WHAT IT CAN DO
    agent config · MCP manifests
    credentials · CI files · sockets
        │
        │   «granted once, reviewed never»
        ▼
WHAT IT ACTUALLY DID
    nine systems, or none of them,
    plus the agent's own account of itself
        │
        │   «no way to check the claim
        │    against the act»
        ▼
WHAT WE ACTUALLY MEANT
    a slack thread · an ADR · a policy
    describing a config nobody applied

    → Memnox connects those three.
```

These are the three kinds of truth this project has always named, under the words a user
would use. **Can** is technical truth, read from configuration. **Did** is runtime truth,
read from what was intercepted. **Meant** is organizational truth, read from what the
company said about itself.

**Why the existing tools do not close it.** Each reality alone is a product that already
exists and is crowded. Can alone is an inventory, and the compliance vendors are shipping
one. Did alone is observability, a solved category with incumbents. Meant alone is
enterprise search, which is where good products go to be ignored. Two of the three is a
feature. Three is a position.

**What the join makes possible.** Only something holding all three can say *this is
technically authorized and organizationally wrong, right now, and here is the evidence*.
That sentence is not expressible in any permission system that exists, and it is the
sentence the whole product is for.

## An organizational instruction is evidence, not a policy

This is the line the whole product rests on, and it is what keeps **meant** safe to read.

A sentence somebody wrote in a channel, a rule in `AGENTS.md`, a paragraph in a runbook:
each is material a rule can match on, carrying its excerpt, its author and its date. None of
them permits an action by itself. A machine may propose; only a person or a system of record
confirms.

The moment text an agent can reach is able to permit an action, every document in the
company becomes a way to write policy, and prompt injection becomes privilege escalation. A
type, not a classifier: trust is set by whoever supplied the block, and the evaluator
refuses to treat untrusted content as intent.

## Three effects, and the words for them

There are three effects and no others. The situations below use the words a person reaching
for the product would use, and the product uses its own names for the same three:

| In these situations | In the product, the console and the wire |
|---|---|
| allow | `allow` |
| ask | `escalate`, because a question resolves to a named person who holds the authority |
| deny | `withhold`, because the refusal names the alternative that is permitted |

The plain words are right for describing the pain and wrong for the contract. **Withhold**
carries the thing that makes a refusal survivable: an agent told only *no* abandons the task
and the developer blames the tool, an agent told what to use instead finishes the work.
**Escalate** carries the thing that makes an approval worth reading: it resolves to somebody,
rather than stopping. Never rename either in code or on the wire to match this document.

## Sixty situations

Thirteen runs, and the boundaries are not arbitrary: each run is a different person with a
different budget, arriving in the order a company actually arrives at them.

- **01 to 03** &nbsp; What is even there
- **04 to 07** &nbsp; Autonomy without blind trust
- **08 to 11** &nbsp; What quietly grew
- **12 to 17** &nbsp; What it actually did
- **18 to 22** &nbsp; What the organization already decided
- **23 to 25** &nbsp; Before you widen it
- **26 to 29** &nbsp; Knowledge that walks out of the door
- **30 to 33** &nbsp; Policy against reality
- **34 to 41** &nbsp; The dangerous surface
- **42 to 47** &nbsp; The fleet nobody counted
- **48 to 51** &nbsp; Should it, right now
- **52 to 56** &nbsp; After the fact
- **57 to 60** &nbsp; The answer layer

For each situation: **Today** is what is happening and why the existing tools do not close it. **Memnox** is what the product does. **They get** is what the person walks away with. A **limit** is stated where one exists rather than left for somebody to discover.

---

### 01 to 03 &nbsp;·&nbsp; What is even there

#### 01. "I do not know what my agent can access."

**Today.** A developer installs a coding agent, three MCP servers and an editor extension,
granting each one what it asked for at the time. Weeks later the only honest way to answer
**can this thing modify my GitHub** is to open six configuration files in four formats and
read them.

**Memnox.** **memnox** reads what is already on disk: agent configuration, MCP manifests,
editor settings, shell profiles, CI workflow files, credential chains, container sockets.
Then it says what each agent can touch, by name and by count.

**They get** they understand their own environment for the first time, in twenty seconds,
with no account and nothing transmitted.

```
T + 0:20 · NPX MEMNOX

$ memnox

YOUR AI ENVIRONMENT

Claude Code
  ├── filesystem      READ + WRITE
  ├── shell           EXECUTE
  └── github  «mcp»   12 read · 6 write

Cursor
  ├── filesystem      READ + WRITE
  └── postgres «mcp»  production URL, write

Codex CLI
  └── shell           EXECUTE «sandboxed»

⚠ 6 capabilities can change external state
⚠ 0 of them are covered by any rule
```

#### 02. "I gave it access months ago and forgot."

**Today.** Agent configuration has become permanent infrastructure. A server is added once,
for one afternoon's task, and nothing in any of these tools carries a review date. Nobody
ever asks whether it is still needed.

**Memnox.** **memnox watch** keeps the inventory current and reports what arrives: a new
server, a new tool, a new credential, a widened path. Each report names what was added and
how much of it can write.

**They get** a forgotten permission stops being invisible risk and becomes something with a
date on it.

```
WATCH · A SERVER ARRIVES

⚠ NEW MCP SERVER

  stripe

  14 tools discovered
   5 write-capable
   1 destructive

  No rule covers any of them.

  «added by ~/.config/mcp.json, 4m ago»
```

#### 03. "I cannot tell which of these tools are dangerous."

**Today.** One server can expose thirty tools. Nobody wants to read thirty descriptions, and
no client anywhere shows which of them change something outside the machine.

**Memnox.** Every tool is classified by effect: read, write, destructive, or unknown. Taken
from the tool's own annotation where it has one, inferred with a stated method where it does
not.

**They get** **Thirty one tools** becomes **eight of them can change external state**, which
is the only version of that sentence anybody can act on.

```
EFFECT, PER TOOL

github  «mcp»                 31 tools

READ                              23
  ✓ list_repositories
  ✓ get_issue
  ✓ search_code

WRITE                              6
  ⚠ create_issue
  ⚠ merge_pull_request
  ⚠ update_file

DESTRUCTIVE                        2
  ✕ delete_branch
  ✕ delete_repository

→ 8 of 31 change external state
```

---

### 04 to 07 &nbsp;·&nbsp; Autonomy without blind trust

#### 04. "I want it to run overnight and I do not dare."

**Today.** The wish is **let it handle this while I sleep**. The block is four questions
nobody can answer in advance: what if it deletes something, merges something, sends
something, deploys something. So autonomy gets capped far below what the agent could
actually be trusted with.

**Memnox.** Three decisions and no policy language to learn: allow, ask, deny. A dangerous
action becomes a question rather than a surprise, and the question arrives where the person
already is.

**They get** more autonomy without more trust. This is the central commercial story.

```
THE AGENT ASKS INSTEAD OF ACTING

Claude Code wants

  github.merge_pull_request
  payments-service  #821  →  main

  ⚠ APPROVAL REQUIRED

  «this repository requires review»

  [a] allow once      [p] allow the pattern
  [d] deny            [w] why
```

#### 05. "I do not want to approve everything."

**Today.** The other half of the same problem. A team that does not trust its agents ends up
confirming every read, every command, every branch. The agent is no longer autonomous, it is
just slower than doing the work by hand.

**Memnox.** Consequence decides. Reading a repository allows and prints nothing. Creating a
local branch allows. Merging to production asks. Deleting a customer refuses.

**They get** the approvals that survive are the ones worth reading, which is the only reason
anybody keeps reading them.

```
RANKED BY WHAT IT COSTS TO BE WRONG

read repository             ALLOW
create local branch         ALLOW
run the test suite          ALLOW
open a pull request         ALLOW
create an issue             ALLOW

merge to main               ASK
refund a payment            ASK
send to an external host    ASK
message a customer channel  ASK

delete a customer           DENY
force push to main          DENY
revoke a production key     DENY
```

#### 06. "Why did it block my agent?"

**Today.** Security tools say BLOCKED and stop there. The developer cannot tell whether the
rule is right, whether the agent was wrong, or whether the tool is broken. The fastest fix
available to them is to turn it off.

**Memnox.** **memnox why** prints the actual tool call, the rule that matched, and the
evidence that rule stood on. Built from the match itself, never written afterwards by a
model.

**They get** a refusal somebody can argue with, which is the only kind anybody keeps
switched on.

```
$ MEMNOX WHY DEC_01JQ2

ACTION     github.merge_pull_request
AGENT      Claude Code
DECISION   DENY

WHY

  1  this repository requires two approvals
  2  #821 carries one
  3  no CODEOWNER has reviewed it
  4  policy: production merges need review

EVIDENCE

  CODEOWNERS          payments-service
  branch protection   main
  pull request        #821
  policy              release-review@v3
```

#### 07. "It says it can deploy. Can it?"

**Today.** Ask an agent whether it can deploy production and it will often say yes. It is
answering about its instructions. It is not answering about its credentials, its tools, its
repository access, or the permission waiting at the other end.

**Memnox.** The answer comes from the environment rather than from the agent: what
credentials exist, what they actually permit when resolved against the provider, what
tooling is present, and what still refuses.

**They get** an assumption replaced by an observation.

```
ASKED OF THE MACHINE, NOT THE MODEL

Can Claude Code deploy production?

HAS

  ✓ aws credentials, profile prod
  ✓ deploy CLI on PATH
  ✓ write access, payments-service
  ✓ the deploy script

BUT

  ✕ iam denies ecs:UpdateService
  ✕ the release policy wants one approval

  → NOT AUTHORIZED

  «it would have tried, and failed at
   the third step, having already
   pushed a tag»
```

---

### 08 to 11 &nbsp;·&nbsp; What quietly grew

#### 08. "It holds far more than it needs."

**Today.** A coding agent needs to read a repository and open a pull request. It has GitHub
admin, AWS, Stripe, Slack, the database and the whole filesystem, because that was the
fastest way to unblock it once.

**Memnox.** Grant against use. What each agent was permitted, what it actually touched, and
the distance between the two, over a window it states rather than hides.

**They get** least privilege written from behaviour rather than from imagination, which is
the strongest thing a tool can do with no account at all.

```
AFTER ONE WEEK OF ORDINARY WORK

UNUSED AUTHORITY           Claude Code
                           7 days · 214 sessions

github         24 tools available
                6 ever called
               18 never called

               «of the 18, three can
                change external state»

aws            reachable, never used
stripe         reachable, never used
docker.sock    reachable, never used

→ it used 27% of what you granted it
```

#### 09. "Something changed and I do not know what."

**Today.** Yesterday it behaved one way. Today it reaches something new. Somebody installed
a server, edited a config, added a credential, or an update shipped overnight, and none of
those was recorded as an event anywhere.

**Memnox.** **memnox diff** compares this scan against the last one and names what moved, in
both directions, with the cause where the cause is knowable.

**They get** configuration drift becomes an event instead of a mystery.

```
$ MEMNOX DIFF --SINCE YESTERDAY

+ slack  «mcp»              8 tools
+ ~/.aws/credentials        readable, 3 agents
+ /srv/production           readable, Cursor

  Claude Code · filesystem
    READ            →  READ + WRITE

  Cursor · network
    2 hosts         →  unrestricted

- linear «mcp»              removed

«4 changes widen authority, 1 narrows it»
```

#### 10. "A server appeared and nothing reviewed it."

**Today.** A new MCP server can multiply what every agent on the machine reaches, and
installing one takes a single line in a JSON file. There is no review step anywhere on that
path.

**Memnox.** A new server is treated as an event with a subject: who published it, what it
asked for, how many other installs carry it, and how long it has existed.

**They get** authority stops expanding silently.

```
HELD, PENDING A PERSON

⚠ NEW CAPABILITY

  server       stripe
  publisher    unverified
  age          6 days
  seen on      1 of your 14 machines

  14 tools     9 read · 5 write
  credentials  STRIPE_SECRET_KEY
  network      unrestricted

  No rule covers any of it.

  [review]   [protect]   [disable]
```

#### 11. "It used a tool I did not know it had."

**Today.** Tools arrive through servers, servers arrive through configuration, configuration
arrives through a teammate's pull request. By the time an agent calls something surprising,
nobody remembers where it came from.

**Memnox.** Every capability traces back to the file that granted it and the day it
appeared.

**They get** provenance for authority, not just for code.

```
$ MEMNOX TRACE REFUND_PAYMENT

  tool         refund_payment
  server       stripe
  reached by   Claude Code, Cursor

  granted by   ~/.config/mcp.json
  added        14 days ago
  added in     a pull request by Daniel

  effect       WRITE, irreversible
  called       twice, both last Tuesday
```

---

### 12 to 17 &nbsp;·&nbsp; What it actually did

#### 12. "What did it do while I was away?"

**Today.** The instruction was **fix the failing auth tests** and the developer left. Three
hours later there is a branch, a pull request, and no account of how any of it happened that
was not written by the thing being asked about.

**Memnox.** One session, one timeline, assembled from what was intercepted rather than from
a transcript. Every row is something that was observed at a seam.

**They get** a factual history instead of a summary.

```
SESSION 4F2A · 3H 04M

CLAUDE CODE

10:04  read      src/auth.ts
10:07  search    "refresh token"
10:11  write     src/auth.ts
10:14  read      .env             ⚠ WITHHELD
10:15  read      .env.example
10:18  shell     npm test         ✓ 14 passed
10:21  git       branch auth-refresh
10:25  github    opened #842
10:31  github    merge #842       ⚠ WITHHELD

«2 withheld · 1 alternative taken
  0 escalations · work completed»
```

#### 13. "I do not trust its own summary."

**Today.** **I completed everything successfully** is generated text. A failed command, a
blocked call, a skipped step and a clean run all produce the same confident paragraph.

**Memnox.** What was observed at the seam is the record. Where that disagrees with the
agent's account of itself, the seam wins.

**They get** independent observability, which is the whole difference between a report and a
claim.

```
THE CLAIM AGAINST THE RECORD

AGENT CLAIM

  "Deployment completed successfully."

MEMNOX OBSERVED

  ✓  npm run build
  ✓  npm test              14 passed
  ✕  POST /deploy          500, 2 retries
  ·  no deployment recorded anywhere

  → DEPLOYMENT FAILED

  «the build and the tests are real.
   the deployment is not.»
```

#### 14. "Something changed in production and nobody knows who."

**Today.** The change is real. The candidates are a person, an agent, a pipeline and a
script, and each of those keeps its record in a different system, with a different clock and
a different idea of an actor.

**Memnox.** Causation is carried where it can be carried, in commit trailers, pull request
bodies and pipeline claims, and stitched by actor and time where it cannot. Every hop says
which of the two it was.

**They get** accountability that survives crossing a system boundary.

```
PRODUCTION CONFIG CHANGED · 14:05

  who       Claude Code
            agent claude-8472
  acting    for Moïse
  tool      github.update_file
  under     approval apr_7731
            Sarah, 09:42

  EVIDENCE

    pull request  #921        propagated
    slack         #platform   propagated
    pipeline      run 4412    inferred

  «one hop is inferred and says so»
```

#### 15. "Which agent did this?"

**Today.** Four products, all of them writing commits, opening pull requests and calling the
same APIs. From the outside they are indistinguishable, and a rule written about one of them
governs nothing the moment the team adopts another.

**Memnox.** Three fields, all of them required before an agent is enrolled. The kind is the
product, the role is the job, the principal is the person it acts for. Policy is written
about the role.

**They get** an incident report that names a human rather than an API key.

```
WHO ACTED

  agent       OpenClaw
  kind        openclaw        «the product»
  role        release-engineer «the job»
  principal   Sarah Okonkwo   «the person»

  tool        deploy_service
  target      payments
  at          14:03

  «swap the product tomorrow and every
   rule about release-engineer still holds»
```

#### 16. "Two agents are working on the same thing."

**Today.** One agent is editing payments.ts. So is another, in a different terminal, for a
different person. Nobody finds out until the conflict, or worse, until neither conflicts and
both land.

**Memnox.** The collision is visible in the ledger, because both agents act through seams
that record what they touched.

**They get** multi agent collisions caught while they are still cheap.

**Limit.** It reports the collision. It does not open the diff and decide which agent is
right. That is code review, a different product with a different buyer, and it is out of
scope permanently.

```
⚠ CONCURRENT WORK

  payments.ts

    Claude Code   Moïse    writing, 12m
    Codex         Sarah    writing, 4m

  A production-critical file, two agents,
  two branches, no shared awareness.

  [pause claude]  [pause codex]  [show both]
```

#### 17. "Two agents are building the same thing."

**Today.** One is implementing OAuth refresh from a ticket. Another starts the same work
from a different ticket. Both finish. One of them is thrown away, and the cost was paid
twice.

**Memnox.** Overlapping work is a detector over what the agents touched and what they were
asked for, proposed to a person rather than acted on.

**They get** duplicate engineering caught before it has been duplicated.

```
⚠ DUPLICATE EFFORT

  Claude Code   "oauth token refresh"
  Codex         "refresh token rotation"

  same files        src/auth/tokens.ts
                    src/auth/session.ts
  same issue area   #442
  branches          oauth-refresh
                    token-rotation

  started 3 days apart, neither knows
```

---

### 18 to 22 &nbsp;·&nbsp; What the organization already decided

#### 18. "It proposed the thing we rejected."

**Today.** The decision not to use Redis was made in a channel in August, written up as an
architecture decision, and argued through in a pull request. None of that is in the
repository the agent reads, so it proposes Redis again in September, reasonably.

**Memnox.** The decision, its reasoning, its evidence and what it replaced, retrieved when
it bears on what is being proposed.

**They get** the company's own decisions reach the agent that is about to contradict one.

```
WHY NOT REDIS HERE?

REJECTED                      19 Aug

  1  the team wants stateless deploys
  2  our infrastructure has no managed
     Redis in eu-west
  3  recorded as ADR-019

EVIDENCE

  slack     #architecture     12 Aug
  doc       ADR-019           13 Aug
  github    #821, closed      18 Aug

  ✓ still in force
  «nothing supersedes it, last confirmed
    when ADR-019 was reaffirmed in June»
```

#### 19. "It keeps breaking a rule we wrote down."

**Today.** The rule lives in an architecture decision, in AGENTS.md, in a README and in the
head of whoever wrote it. An agent reads some of that, some of the time, and follows it when
the context window allows.

**Memnox.** A written rule becomes evidence a policy can match on, so it is checked at the
action rather than hoped for in a prompt.

**They get** documentation that is actually load bearing.

```
⚠ CONFLICTS WITH A STATED RULE

  action     added a direct database call
             src/billing/invoice.service.ts

  rule       services reach data through a
             repository, never directly

  stated in  ADR-023
             AGENTS.md, line 41
             reviewed 4 times in 2025

  instead    BillingRepository.find() is
             the permitted path

  → ASK
```

#### 20. "The document says one thing, the system does another."

**Today.** The security policy requires two approvals on production. The repository enforces
none. Both are true, both are written down, and no tool holds them at the same time, so
nobody has ever compared them.

**Memnox.** What the company says and what its systems enforce are both read, and the
distance between the two is reported as a finding.

**They get** the gap between intent and configuration, which is the finding nobody currently
owns.

```
⚠ POLICY GAP

  documented   2 approvals on production
               Security Policy §4.2

  enforced     0
               main carries no protection rule

  affected     payments-service
               billing-api
               3 more

  ⚠ 11 deploys have gone out under this
    gap, the most recent 2 days ago
```

#### 21. "Nobody can say who authorized this agent."

**Today.** The agent holds a token. The token was minted by somebody, at some point, for
some reason, and the record of that is a Slack message if it exists at all.

**Memnox.** Authority is a chain with a person at the top of it: who delegated what, to
whom, with what ceiling, until when, and whether it could be passed on.

**They get** human accountability for autonomous action.

```
$ MEMNOX WHY ACT_9D21

ACTION        deploy payments-service

AUTHORIZED BY

  Sarah Okonkwo         platform lead
  in                    #platform, 09:42
  ceiling               production deploy,
                        payments only
  transferable          no
  expires               in 4 days

RELATED

  jira     PAY-821
  github   #821
```

#### 22. "Why was it allowed?"

**Today.** Every governance tool explains its refusals. Almost none explains the far more
interesting case: the action that went through, and the reason anybody should be comfortable
that it did.

**Memnox.** The same explanation, run on an allow. The conditions that were met, named one
at a time.

**They get** **Why did we trust it** is a better question than **why did we block it**, and
it is the one an auditor asks first.

```
$ MEMNOX WHY DEC_01JR8

ACTION      github.merge_pull_request #821
DECISION    ALLOW

BECAUSE

  ✓ two approvals recorded
  ✓ one of them from a CODEOWNER
  ✓ main is protected, checks passed
  ✓ no freeze in force
  ✓ inside the declared change window
  ✓ within the release-engineer ceiling

APPROVED BY   Sarah, Daniel
```

---

### 23 to 25 &nbsp;·&nbsp; Before you widen it

#### 23. "What happens if I give it more?"

**Today.** A team wants to raise an agent's autonomy and has no way to see the consequence
except to do it and find out. So either nothing moves, or something moves and nobody sized
it.

**Memnox.** The change is replayed against traffic that already happened, in both
directions: what it would newly permit, and what it would newly refuse.

**They get** a widening that is a decision rather than a hope.

```
$ MEMNOX WHAT-IF "GITHUB: +WRITE +MERGE"

  CURRENT     read, issues
  PROPOSED    read, issues, write, merge

AGAINST THE LAST 30 DAYS

  + 3 capabilities
  + 2 that change external state

  would newly allow      41 actions
  would newly refuse      0
  would stop asking      18 approvals

  conflicts with          2 policies
  affects                 6 agents
                          14 machines
  needs approval from     platform

  «the 41 are listed, by agent and day»
```

#### 24. "Can this agent do this, right now?"

**Today.** Answering it properly means checking credentials, then IAM, then the repository,
then the policy, then whether anything is currently on fire. Five systems, four people, an
afternoon.

**Memnox.** One question. The answer separates what is technically possible from what is
organizationally permitted, and says plainly which is which.

**They get** the question people actually ask, answered in one place, with the evidence
attached.

```
$ MEMNOX EXPLAIN "CAN CLAUDE DEPLOY PAYMENTS?"

TECHNICALLY         yes
  ✓ credentials, tooling, repository

ORGANIZATIONALLY    not right now
  ✕ freeze in force since 09:12  INC-428
  ✕ the release policy wants one
    platform approval, and nobody
    is currently on call

  → ESCALATE, not deny.
    Asked: Sarah, who owns the freeze.

EVIDENCE
  slack #incident · INC-428
  jira PAY-821 · github #821
```

#### 25. "The answer is spread across five systems."

**Today.** A question as small as **why can this not deploy** needs Slack, GitHub, Jira, a
document, a README and three pull requests. The person who assembles that answer will have
to assemble it again next month.

**Memnox.** One answer, citing into each system it drew from, with a count of what it could
not show this particular reader.

**They get** organizational archaeology stops being somebody's job.

```
ONE QUESTION, FIVE SOURCES

Why can't the release agent deploy?

  Because a platform approval is required
  and the freeze from INC-428 is in force.

  CITED

    slack    #platform, 09:42
    slack    #incident, 09:12
    jira     PAY-821
    github   #821, CODEOWNERS
    doc      Release Policy §2

  withheld   1 source you may not read
```

---

### 26 to 29 &nbsp;·&nbsp; Knowledge that walks out of the door

#### 26. "Our decisions disappear into Slack."

**Today.** The decision to use PostgreSQL was made across forty messages on a Tuesday. Two
months later the question comes back, the thread is unfindable, and the decision gets made
again, differently.

**Memnox.** A decision is extracted from the conversation as a candidate, carrying its
participants, its date, its reasoning and the excerpt it came from. A person confirms it
before it counts.

**They get** a conversation becomes something the company can be asked.

```
DECISION · PROPOSED, NOT STORED

  "PostgreSQL rather than MongoDB
   for the events store."

  when      19 Aug
  who       Sarah, Daniel, Moïse
  why       relational reporting, and
            one operational database

  from      #architecture, 19 Aug, 14:02
  related   ADR-034, #812

  [confirm]   [edit]   [not a decision]

  «a machine proposes. only a person
    or a system of record confirms.»
```

#### 27. "A new engineer cannot find out why anything is like this."

**Today.** The answer is **because we tried the other thing in 2024**, and it lives with
whoever was there. Onboarding is a series of interruptions to the people who remember.

**Memnox.** The decision, the alternatives that were rejected, the evidence and what
happened afterwards, asked in a sentence.

**They get** institutional context on the first day rather than in the first year.

#### 28. "The person who knew this has left."

**Today.** The code stays and the reasoning goes. Every architectural oddity becomes load
bearing, because nobody remaining can say whether it still needs to be.

**Memnox.** Why, who, when, on what evidence, and what happened next, held independently of
the person who decided it.

**They get** continuity that does not depend on anybody staying.

#### 29. "I cannot tell whether this decision still holds."

**Today.** A document says use service A. That was six months, two architectures and one
reorganisation ago, and nothing in the document knows any of that.

**Memnox.** Every claim carries when it was last confirmed. A decision whose ground has
moved is flagged rather than quietly reused.

**They get** stale knowledge stops being indistinguishable from current knowledge.

```
⚠ POSSIBLY OUTDATED

DECISION   "Use service A for billing."

  stated       12 Feb
  confirmed    never since

  THE GROUND HAS MOVED

    github   #1188, billing moved to the
             new events pipeline    4 Jun
    deploy   service A scaled to zero
                                   11 Jun
    slack    #billing, "we don't call A
             any more"             19 Jul

  [still true]  [supersede]  [ask Daniel]
```

---

### 30 to 33 &nbsp;·&nbsp; Policy against reality

#### 30. "Our policies are written and nobody follows them."

**Today.** The rule about Friday deploys is in a PDF. Nothing reads a PDF at the moment
somebody deploys on a Friday.

**Memnox.** The policy is evaluated where the action happens, and the refusal cites the
policy that refused it.

**They get** a policy that operates instead of a policy that is filed.

```
⚠ POLICY VIOLATION · BLOCKED

  agent     Codex
  action    deploy production
  at        Friday 16:45

  policy    no production deployments
            after 16:00 on a Friday
            Change Policy §3
            «written 2024, never enforced
              by anything until now»

  → DENY.  Next window: Monday 09:00.
    [request an exception]
```

#### 31. "The same rule has to hold across five agents."

**Today.** Each product has its own settings, its own allow list and its own idea of a
permission. A rule agreed once has to be reimplemented five times, and it drifts
immediately.

**Memnox.** One rule, written once, enforced at whatever seam each product actually offers,
without replacing the controls that product already ships.

**They get** one control plane over agents that share nothing with each other.

```
RULE: PRODUCTION DEPLOY → ASK

  Claude Code   tool hook           enforcing
  Cursor        mcp proxy           enforcing
  Codex CLI     shell wrapper       enforcing
  OpenClaw      egress + credential enforcing
  Hermes        mcp proxy           observing

  one rule · five mechanisms

  «Hermes is observing because its seam
    was turned on yesterday. it is not
    counted as governed until it enforces.»
```

#### 32. "I run five agents and cannot say which is riskiest."

**Today.** Each one was evaluated on its own, on a different day, by whoever installed it.
Nothing anywhere puts them side by side.

**Memnox.** The same findings, per agent, on this machine, decomposed into what produced
them.

**They get** a fleet somebody can compare, instead of five tools they evaluated separately.

**Limit.** It ranks what is configured here. It is never a safety rating of the products
themselves. A league table of vendors would be a claim about software nobody tested, and it
does not get built.

```
ON THIS MACHINE

  OpenClaw       7 findings
                 3 write tools
                 messaging
                 unrestricted network

  Claude Code    4 findings
                 6 write tools · shell

  Codex CLI      1 finding
                 sandboxed

  Cursor         1 finding
                 read only

  «ranked by what is configured here,
    not by the product»
```

#### 33. "An update changed what my agent can do."

**Today.** Agent software updates itself. Tools are added, defaults change, a model changes
underneath, and none of that arrives as a security event anywhere.

**Memnox.** Each agent is compared against its own baseline, and the finding names the cause
rather than raising an alarm about it.

**They get** an update becomes an observable change to authority.

```
AGENT CHANGED

  Claude Code

  before      12 capabilities
  after       17

  new         +5 tools, 2 write-capable
              +1 network destination

  cause       updated 2.4.1 → 2.5.0
              yesterday, 03:12

  «the cause is named, so the common
    case reads as a change to approve
    rather than a threat to investigate»

  [review]  [accept]  [hold the old rules]
```

---

### 34 to 41 &nbsp;·&nbsp; The dangerous surface

#### 34. "Somebody exposed a credential to an agent."

**Today.** A file moves, a variable is exported, a directory joins an allow list, and an
agent that could not reach production credentials this morning can this afternoon. Nothing
announces it.

**Memnox.** Reachability is recomputed as the machine changes, and a credential becoming
reachable is reported as it happens.

**They get** the dangerous half of configuration drift, caught in minutes rather than at the
next audit.

```
⚠ NEW CREDENTIAL ACCESS · 2M AGO

  agent      Claude Code
  resource   ~/.aws/credentials
             profile prod

  before     not reachable
  now        reachable, read

  cause      workspace root widened to ~/
             settings.json, 3m ago

  «the value was never read into any
    report. what is stored is a path,
    a kind and a hash.»
```

#### 35. "It can reach production and only needs development."

**Today.** The credentials that were to hand were the production ones. The agent's job is
local. Nobody has ever put those two facts next to each other.

**Memnox.** What the role is expected to touch, against what it can actually reach.

**They get** least privilege as a comparison, rather than a policy somebody has to sit down
and write.

```
ENVIRONMENT MISMATCH

  agent       Cursor
  role        local-development
  expects     dev, staging

  reaches     postgres   production, write
              s3         production, read

  used in the last 7 days      never

  [scope to dev]  [ask on production]
```

#### 36. "It is doing local work with production credentials."

**Today.** The same mismatch, at the moment it matters. The task is **fix the local login
bug**. The connection it just opened is to the production database.

**Memnox.** The task and its declared scope arrive with the request, so an action outside
that scope is a fact a rule can match on. No model, no guessing, no classifier on the path.

**They get** a refusal that says **this was not part of what you asked for**, which is one a
developer accepts immediately.

```
OUT OF THE TASK'S OWN SCOPE

  task     "fix the local login bug"
  scope    ./src · dev

  Cursor wants

    postgres.query        production

  ✕ outside the declared scope of
    this task

  instead   the dev database is
            configured and reachable

  → WITHHELD
```

#### 37. "I installed a server and do not trust it."

**Today.** An MCP server is a new capability surface installed by pasting a line. Nothing
between the paste and the first tool call asks what it wants.

**Memnox.** What it declares, what it asks for and what it can reach, before it is trusted
rather than after.

**They get** a capability surface that can be inspected before it is granted.

```
SERVER REVIEW

  unknown-server

  publisher     unverified
  age           2 days
  installs      seen on 1 machine

  21 tools      13 read
                 6 write
                 2 destructive

  filesystem    yes, unrestricted
  network       yes, unrestricted
  credentials   AWS_* · GITHUB_TOKEN

  RISK   HIGH

  [protect]   [disable]   [inspect]
```

#### 38. "I need one tool from a server that ships twenty."

**Today.** The unit of installation is the server. The unit of danger is the tool. Removing
the server to remove one tool costs the nineteen that were the reason for installing it.

**Memnox.** Rules are written per tool. Keep the reads, ask on the writes, refuse the
destructive ones, and the server stays where it is.

**They get** granular authority instead of all or nothing.

```
STRIPE «MCP»

  KEEP
    ✓ get_payment
    ✓ list_payments
    ✓ get_customer

  ASK
    ⚠ create_payment
    ⚠ refund_payment

  DENY
    ✕ delete_customer
    ✕ cancel_subscription

  «the server stays installed. the two
    tools that could not be undone do not
    run without somebody saying so.»
```

#### 39. "It can message people, as us."

**Today.** An agent with Slack, email or a browser can speak to customers, colleagues and
the public. Nothing in that path is different from writing a file.

**Memnox.** Outward communication is an external state action by default, whatever tool it
arrives through and whatever the tool calls itself.

**They get** agents stop being able to speak for people who never agreed to it.

```
⚠ ASK

  Claude Code wants

    slack.send_message
    #customers-eu       47 members

  reason    outward communication,
            addressed to people outside
            this workspace

  preview   "Hi all, we've rolled back
             this morning's release..."

  [send]  [edit]  [deny]  [never here]
```

#### 40. "It created something outside the machine."

**Today.** A ticket, an issue, a message, a pull request, a cloud resource. Each is
trivially cheap to create and impossible to unsee, and each is treated by the agent as an
ordinary tool call.

**Memnox.** Three classes with three defaults. Local usually allows, external state asks or
matches a rule, destructive refuses.

**They get** the line between a draft and an act, drawn where it actually falls.

```
THREE CLASSES

LOCAL                    usually allow
  read · write · run · branch · commit

EXTERNAL STATE           ask, or match
  issue · ticket · message · pull request
  cloud resource · payment · email

DESTRUCTIVE              deny
  delete · force push · revoke · drop
  cancel · terminate · rotate

«the class is taken from the tool's own
  effect, not from its name»
```

#### 41. "It keeps making the same mistake."

**Today.** The agent bypasses the repository layer. It is blocked. Next week it does it
again, and again, and each block is a separate event that nobody adds up.

**Memnox.** Repeated refusals are counted and reported as a finding about the configuration,
because an agent that keeps trying is either missing an alternative or pointed at the wrong
task.

**They get** a failure that teaches instead of a failure that repeats.

```
⚠ REPEATED REFUSAL · 3 TIMES

  agent     Claude Code
  action    direct database access
  rule      ADR-023, repository layer

  12 Aug    blocked
  18 Aug    blocked
  29 Aug    blocked

  ⚠ this rule names no alternative

  → the rule is right and incomplete.
    an agent told only "no" will try
    again next week.

  [name the permitted path]
```

---

### 42 to 47 &nbsp;·&nbsp; The fleet nobody counted

#### 42. "Nobody knows how many agents we have."

**Today.** Every team adopts its own. Some arrive with a seat, some with a pull request,
some inside a product the company already buys. The number anybody quotes is the number they
were told.

**Memnox.** A count from four independent sources, with every row linking to the evidence
that proved it exists.

**They get** the gap between what they thought and what is there, which is theirs rather
than ours, and which no runtime can produce.

```
DAY ONE · THE CENSUS

AI WORKFORCE

  427 agents        «you were tracking 281»

  Engineering 183      Sales          61
  Operations   52      Support        48
  Finance      37      Unattributed   46

WHAT THEY CAN DO

  ⚠  91   no named owner
  ⚠  37   can reach production
  ⚠  18   can read customer records
  ⚠  11   can take a destructive action
  ⚠  46   run where we cannot instrument

WHERE THEY CAME FROM

  runtime enrolment  214   «our machines»
  provider APIs       94   «seats, apps»
  CI and pipelines    71   «workflow files»
  vendor products     48   «SaaS we buy»
```

#### 43. "Somebody is running an agent nobody approved."

**Today.** Shadow AI has the same shape as shadow IT and arrives faster, because installing
an agent needs no procurement, no budget and no ticket.

**Memnox.** An unregistered agent is a row with evidence, not an absence. It is counted
before anybody claims it.

**They get** the agents nobody declared, named.

```
⚠ UNREGISTERED AGENT

  agent      OpenClaw
  seen on    sarah-mbp
  since      6 days

  connected  github      write, 14 repos
             slack       send
             filesystem  ~/

  owner      unclaimed
  policy     unapproved agents need review

  [claim]  [assign an owner]  [contain]
```

#### 44. "Which agents can reach production?"

**Today.** The answer requires asking every team, and it is out of date by the time the last
one replies.

**Memnox.** One question, answered from reachability across every install, rather than from
a spreadsheet somebody maintains.

**They get** blast radius, on demand.

```
$ MEMNOX WHO --RESOURCE PRODUCTION

  Claude Code     ✓   deploy, 3 services
  Codex CLI       ✓   read only
  OpenClaw        ✓   deploy, unrestricted
  Cursor          ✕
  Hermes          ✕

  37 agents reach production
  11 can take a destructive action there
   4 have no named owner

  «every row links to the evidence»
```

#### 45. "Which agents can touch customer data?"

**Today.** The same question about a different class of resource, and the one a regulator
asks first.

**Memnox.** The same query, resolved through what each agent can actually reach rather than
through what it was labelled.

**They get** sensitive data exposure as a list, rather than as an assurance.

```
$ MEMNOX WHO --RESOURCE CUSTOMER-DATA

  Claude Code    ✓  database.read
  OpenClaw       ✓  database.read
                    database.write
                    export
  Codex CLI      ✕

  18 agents can read customer records
   3 can write them
   1 can export them

  ⚠ the one that can export has no
    named owner
```

#### 46. "Its access is indirect, so nobody sees it."

**Today.** The agent holds no database credential. It holds an AWS credential, which reaches
a function, which holds the database credential. Every step of that is documented separately
and nowhere together.

**Memnox.** Reachability is transitive. What an agent can reach through what it can reach is
what it can reach, and saying so is most of the value.

**They get** effective authority rather than declared authority.

```
EFFECTIVE CAPABILITY

  Claude Code
    → aws  «mcp»       credentials, prod
      → lambda:Invoke
        → billing-writer
          → postgres   production

  declared     aws, read
  effective    DATABASE WRITE

  4 hops.  Each one individually
  permitted.  Nobody granted the last.
```

#### 47. "Three harmless tools add up to something dangerous."

**Today.** Read a customer. Write a file. Send a message. Each one is ordinary, each is
allowed, and no evaluator looking at a single action will ever see the third one coming.

**Memnox.** Patterns are detected over the joined ledger rather than over an action, which
is precisely the thing a local runtime structurally cannot do.

**They get** the risk that only exists in the sequence. This is the clearest technical
argument for why the paid half exists at all.

```
⚠ COMBINED CAPABILITY

  Claude Code can

    read      customer records
    write     local files
    send      to an external host

  Together that is a customer data
  export, and no single rule refuses it.

  observed in sequence     twice, 14 days
  same session both times

  [refuse the combination]  [ask on send]
```

---

### 48 to 51 &nbsp;·&nbsp; Should it, right now

#### 48. "It is technically allowed and obviously wrong."

**Today.** The permission is correct. The moment is not. There is an incident open, a freeze
on, a customer on hold, and none of that is expressible in any permission system that
exists.

**Memnox.** The company's current condition is an input to the decision, distributed to
every machine with a mandatory expiry on it.

**They get** the product stops asking whether an agent *may*, and starts asking whether it
*should, now*.

```
TWO ANSWERS, AND THEY DISAGREE

  technically       ✓ authorized
  contextually      ✕ not authorized

  deployment freeze in force

    since    09:12
    reason   INC-421, payments latency
    scope    production, all services
    source   #incident
    expires  when INC-421 closes

  → DENY until the freeze lifts, or
    escalate to the incident owner.
```

#### 49. "It does not know we are in an incident."

**Today.** The agent can see the repository. It cannot see that the whole engineering
organization agreed twenty minutes ago not to touch production. That agreement exists in a
channel.

**Memnox.** A freeze, an incident, a change window or a customer hold is a fact with a scope
and an expiry, compiled into what every evaluator already holds locally.

**They get** situational awareness for something that has no way at all to acquire it.

```
AGENT WANTS: DEPLOY PAYMENTS

MEMNOX SEES

  incident      INC-421 open, sev 2
  freeze        production, all services
  from          #incident, 09:12
  expires       when INC-421 closes
  pull request  #921, waiting on review

  → DENY

  «three other agents were refused the
    same thing today. none of them could
    have known.»
```

#### 50. "It has the context and none of the authority."

**Today.** An agent can be told what the company normally does. Knowing it changes nothing.
A prompt is not a control, and an agent that has read the policy can still act against it.

**Memnox.** Knowledge, evidence and current state resolve into one of three things, at the
moment of the action, in under a millisecond, locally.

**They get** this is the whole product in one line, and it is the reason memory alone is not
enough.

```
THE HEART OF IT

  knowledge    what the company decided
  evidence     where that came from
  state        what is true right now

                    ↓

  ALLOW    the ordinary case, and silent
  ASK      somebody holds this authority
  DENY     nothing here permits it

  A prompt is advice.
  This is a control.
```

#### 51. "Why did it decide to do that?"

**Today.** The question is not which tool it called. It is what it was asked for, what it
had read, which rule applied, who agreed, and what happened next. That trace does not exist
anywhere today.

**Memnox.** One trace, from the task to the outcome, each step naming what it stood on.

**They get** explainable autonomous operation, which is what the regulation being drafted
right now is going to ask for.

```
DECISION TRACE · DEC_01JQ2

  task        "fix the failing auth tests"

  context     src/auth.ts        trusted
              mcp:github/#842    untrusted

  evidence    ADR-023 · CODEOWNERS
  policy      secrets-not-required@v1
  approval    none required at this level
  action      filesystem.read  .env
  outcome     WITHHELD, alternative taken
  result      14 tests passed, #842 opened

  «the untrusted block was evidence.
    it was never allowed to be intent.»
```

---

### 52 to 56 &nbsp;·&nbsp; After the fact

#### 52. "We cannot investigate what the agent did."

**Today.** The reconstruction needs GitHub, the cloud audit trail, Slack, CI, the agent's
own logs and whatever the MCP servers happened to keep. Six systems, six clocks, and a week.

**Memnox.** An incident is an object: a timeline, an owner, what was contained, and a
preserved snapshot of the state it happened in.

**They get** investigation in an afternoon rather than in a week.

```
INCIDENT #421 · PAYMENTS CONFIG

  14:02   session opened     Claude Code
  14:04   read               prod config
  14:05   github.update_file config.yaml
  14:05   deploy triggered   pipeline 4412
  14:06   deploy failed      500
  14:09   contained          agent killed

  agent      claude-8472, for Sarah
  approval   apr_7731
  related    #921

  ⚠ contained on 13 of 14 installs.
    one machine was asleep and is
    still shown as unreached.
```

#### 53. "Was that a person or a machine?"

**Today.** The change is in the log. Whether it was typed, generated, scheduled or scripted
is not, and the systems that hold the answer each model an actor differently.

**Memnox.** One actor model. A person and an agent differ in how they authenticate and in
nothing else, so every action resolves to one of them.

**They get** attribution that does not depend on which system happened to record it.

**Limit.** Per change, the answer is the point. A percentage split of who changed production
is a dashboard tile answering a question nobody acts on, and it does not get built.

```
WHO CHANGED PRODUCTION · 30 DAYS

  Claude Code    41   «acting for 6 people»
  CI             31   «scheduled»
  Sarah          23   «by hand»
  OpenClaw        5   «acting for Sarah»

  Every one resolves to a person.

  ⚠ 4 resolve to a person who has
    since left the company.
```

#### 54. "The auditor wants a trail we do not have."

**Today.** Producing evidence about automated decisions means somebody assembling
screenshots for a week, and the result cannot be verified by anybody outside the company.

**Memnox.** For every meaningful action: who, what, when, where, why, under whose authority,
against which policy, on what evidence, with what outcome. Continuously, and exportable.

**They get** evidence that verifies without the product that wrote it.

```
EVERY GOVERNED ACTION CARRIES

  who          the agent, and the person
  what         the action and its target
  when         to the millisecond
  where        install, environment
  why          the rule that matched
  authorized   the approval, and by whom
  evidence     what the rule stood on
  outcome      what actually happened

  export       signed · hash-chained
               verifiable offline

  «continuous, not assembled. producing
    it must not take a person a week.»
```

#### 55. "Authority grows and nobody notices."

**Today.** No single change is alarming. A server here, a scope there, a credential somebody
needed for an afternoon. Over two quarters the estate is unrecognisable and nothing recorded
the direction of travel.

**Memnox.** Authority is measured over time, per agent and per organization, with each
increase attached to the change that caused it.

**They get** privilege drift as a number somebody can be held to.

```
EXTERNAL WRITE CAPABILITY

  Jan    ██████
  Feb    ████████
  Mar    ██████████████
  Apr    ████████████████████

  +217%  over 90 days

  LARGEST CONTRIBUTORS

    +14   stripe «mcp», 6 machines
    +11   aws «mcp», 4 machines
    + 9   a widened workspace root

  «every one of those was somebody
    unblocking themselves on a Tuesday»
```

#### 56. "The estate is too complicated to reason about."

**Today.** Forty three agents, a hundred servers, twelve hundred tools, eighty seven
repositories, twenty six policies. Each of those is documented in its own place, in its own
vocabulary.

**Memnox.** One model, and everything in the product is a row in it.

**They get** a system somebody can hold in their head, which is a precondition for governing
it.

```
EIGHT NOUNS

  subject     a person, an agent, a service
     ↓
  capability  what it may do, for how long
     ↓
  resource    what that touches
     ↓
  identity    who it acts for
     ↓
  policy      what the company decided
     ↓
  evidence    where that came from
     ↓
  decision    allow · ask · deny
     ↓
  outcome     what actually happened

  Everything else is a view.
```

---

### 57 to 60 &nbsp;·&nbsp; The answer layer

#### 57. "Nobody wrote down that this agent may merge."

**Today.** There is no document saying the agent may merge. There is a CODEOWNERS entry that
allows it, a branch rule that permits it, a message saying it can handle these, a manager
who approved the account, and forty merges nobody objected to. The company has authorized it
without ever deciding to.

**Memnox.** Implicit authorization is derived from those signals and surfaced as a
candidate, which a person either makes explicit or refuses.

**They get** what the company has actually permitted, made explicit before something goes
wrong under it.

```
OBSERVED AUTHORIZATION · CANDIDATE

  "Claude Code may merge pull requests
   in payments-service."

  Nobody has ever stated this.
  It follows from

    github    CODEOWNERS permits it
    github    branch rule permits it
    slack     "claude can handle these"
              Daniel, 4 Jun
    history   41 merges, none reverted
    account   approved by Sarah, 2 Jun

  [make it explicit]   [refuse it]
```

#### 58. "The written policy and what people do disagree."

**Today.** The policy says two approvals. In practice a quarter of production deploys go out
with one and a nod in a channel. Everybody knows this and nothing measures it.

**Memnox.** Both are measured. What the policy requires, what actually happened, and the
exception people have quietly standardised on.

**They get** how the organization really works, which is the only honest starting point for
a policy anybody will follow.

```
POLICY AGAINST BEHAVIOUR · 90 DAYS

  POLICY     2 approvals on production

  OBSERVED   214 deploys

    73%   followed the policy
    27%   did not

  THE COMMON EXCEPTION

    a platform lead approving in
    #platform rather than on the PR
                        51 of 58 cases

  → either the policy is wrong, or
    that channel is already a control
    and should be recognised as one.
```

#### 59. "We answer the same questions every week."

**Today.** A developer asks whether the agent can merge. Security asks which agents touch
GitHub. A manager asks who approved something. Platform asks what changed. Four people
assemble four answers from the same five systems.

**Memnox.** One layer answers all of them, because all of them are the same handful of nouns
asked from different directions.

**They get** the questions stop being research.

```
FOUR ASKERS, ONE STORE

  what can it do?        → capability
  what did it do?        → the ledger
  why?                   → evidence
  who allowed it?        → identity
  what if we change it?  → simulation

  Same store. Four askers.
  One answer, and it cites.
```

#### 60. "I do not want to learn another dashboard."

**Today.** Every tool in this category arrives with tabs. The question a person has is a
sentence, and turning it into a filtered view is work they never asked to do.

**Memnox.** The question, in the words they would have used anyway.

**They get** the interface is the question.

```
THE WHOLE SURFACE

$ memnox explain  "can Claude safely deploy
                    payments right now?"

$ memnox why      "was the production
                    deploy blocked?"

$ memnox who      "can modify the payments
                    database?"

$ memnox what-if  "we give Codex production
                    access?"

«four verbs. no tabs. every answer
  cites what it was built from.»
```

---

## The fifteen to build for

Not all sixty become features. These are the ones that would make somebody change how they
work, ranked by that rather than by how hard they are. **A phase of work that closes none of
these is a phase that can wait.**

| | The situation | What answers it | Who feels it | |
|---|---|---|---|---|
| 01 | "What can my agent access?" | Discovery, read off the disk | Developer | 01 |
| 02 | "Can I safely let it run?" | Allow, ask, deny | Developer | 04 |
| 03 | "What did it actually do?" | The session timeline | Developer | 12 |
| 04 | "Why was it blocked, or allowed?" | memnox why | Developer | 06 |
| 05 | "What changed?" | memnox diff | Developer | 09 |
| 06 | "This server has too much access." | Effect, per tool | Developer | 03 |
| 07 | "Can this agent do this?" | memnox explain | Developer | 24 |
| 08 | "It violated a decision we made." | Organizational evidence | Team | 18 |
| 09 | "Why is this action not authorized?" | One answer, five systems | Team | 25 |
| 10 | "Who authorized this?" | Identity, and the chain above it | Company | 21 |
| 11 | "Which agents reach production?" | memnox who | Platform | 44 |
| 12 | "Our policy says X, reality is Y." | The policy gap | Enterprise | 20 |
| 13 | "Two agents are conflicting." | The ledger, never the diff | Engineering | 16 |
| 14 | "We lost the reasoning for this." | Decision history | Engineering | 26 |
| 15 | "Widen autonomy, safely." | memnox what-if | Enterprise | 23 |

**The shape of that list.** All seven of the first seven are the developer's, and every one
works with no account and no network. That is the adoption engine and it earns nothing.
Everything from eight down needs the company's own systems, another person, or a fleet, and
that is the entire paid product. The split is not a pricing decision, it is what each row
requires in order to be true.

**Who feels it is not who buys it.** The developer feels the first seven and cannot sign
anything. The security lead can sign and does not care that one laptop is hardened. Both
journeys have to work end to end, and the second one opens on a number rather than a scan.

## Three layers of pain

The most useful division, because it is also the order somebody gets to it. Each layer
changes who is asking, what they are asking for, and what it would take to answer them.

### Layer one · the developer's own machine

Situations 01 to 17. No account, no cloud, no network. This is the open half and it earns
nothing, which is exactly why it works.

- **I use AI agents.**
- **I do not know what they can access.**
- **I do not know what they are doing.**
- **I am afraid to give them more autonomy.**

memnox · doctor · harden · watch · diff · why · trace

### Layer two · the engineering team

Situations 18 to 33. GitHub, Slack, Jira, Linear and the documents connect, and the
questions change shape entirely.

- **Why did the agent do this?**
- **Does it violate something we decided?**
- **Who decided that, and is it still true?**
- **Is this agent actually allowed to?**

This is where organizational memory stops being another search box.

### Layer three · the company

Situations 34 to 60. Agents, servers, GitHub, Slack, Jira, Linear, documents, CI and cloud,
joined into one decision graph.

- **What AI do we have, and what can it reach?**
- **Who authorized it, and why was it allowed?**
- **Did it follow the policy we wrote?**
- **What happens if we give it more?**

Which is a much bigger question than AI security.

## Ten things worth a reaction

Cut to what would actually make somebody stop and read the screen twice. Everything else in
the product exists to make one of these ten true rather than clever.

- **memnox** &nbsp; "I did not know my agent had all this access."
  Their real machine, their real configuration, no demo data anywhere. It cannot be faked by
  a competitor and it cannot be faked by us.

- **explain** &nbsp; "Now I understand exactly what it can do."
  Not a list of tools. What each one reaches, transitively, resolved against the provider
  rather than guessed from a file.

- **harden** &nbsp; "It fixed the dangerous part and I learned no new security product."
  Every step prints its undo before it runs. Breaking somebody's build at midnight is the
  one failure with no recovery.

- **watch** &nbsp; "Somebody added a server and Memnox noticed immediately."
  A new capability surface arrives as an event with a publisher, an age and a request,
  rather than as a line in a JSON file.

- **interception** &nbsp; "My agent actually tried to do that."
  The moment it stops being advice. A verdict nobody is obliged to ask for is a suggestion,
  and most agents will never ask.

- **why** &nbsp; "I know exactly why it was blocked."
  Five lines, built from the rule that matched, never regenerated afterwards by a model. An
  explanation invented after the fact is a plausible story about a decision.

- **diff** &nbsp; "Something changed, and it found it."
  Configuration drift with a cause attached, so the common case reads as a change to approve
  rather than a threat to investigate.

- **the fleet** &nbsp; "All four agents are visible in one place."
  One row per role across every machine, with the outlier named. The laptop with the proxy
  switched off is the story, not the thirty nine with it on.

- **the organizational answer** &nbsp; "It checked Slack, GitHub, Jira and the docs and told me whether this is actually allowed."
  The moment the product stops being a security tool. This is the one nobody else is
  positioned to build, and it is why the graph is the moat.

- **what-if** &nbsp; "Before giving it more power, I can see what that enables."
  Replayed against traffic that already happened, in both directions. This is what a renewal
  is bought with.

## The loop

The product is not a set of capabilities arranged around a diagram. It is one path a person
walks, and the whole design exists to survive every step of it. Nothing here is a funnel
stage; each is a thing that either works or ends the adoption.

 1. **Install** One command. No account, no key, nothing transmitted.
 2. **Scan** Something true and uncomfortable about their own machine, in twenty seconds.
 3. **"It can do *what*?"** The first real reaction, and the only one that spreads without marketing.
 4. **Explain** What that access actually reaches, transitively.
 5. **Harden** Most of it closed, every step printing its undo.
 6. **They go back to work** Not a demo. The thing they were about to ask their agent for anyway.
 7. **A real action happens** Memnox is on the path, and silent for every ordinary one.
 8. **Allow, ask or deny** The first refusal, redirected to a named alternative, and the work still lands.
 9. **"Why?"** Five lines, with the actual rule and the actual evidence.
10. **They trust it** Which is the whole currency, and it is spent the first time a refusal is wrong.
11. **The configuration changes** Somebody installs a server. Memnox says so before anything uses it.
12. **They connect GitHub** Then Slack, then Jira, then the documents. A second person arrives.
13. **Memnox learns what was meant** Decisions, ownership, precedent, and the current state of the company.
14. **"Should this agent be allowed?"** Answered from all three realities at once, with citations.
15. **"Can we give it more?"** Simulated against thirty days of real traffic, in both directions.

**Steps 1 to 5 are one sitting.** They cost nothing, earn nothing, and are the reason
anything is earned later. A product that asks for a sign in here has already conceded that
its runtime cannot stand alone.

**Step 8 is the hinge.** The first refusal either names an alternative and the work
finishes, or it does not and the agent abandons the task. One of those gets the tool
uninstalled that afternoon.

**Step 10 is the whole currency.** Trust is spent the first time a refusal is wrong, and
there is no version of this product that recovers from breaking somebody's build at
midnight.

**Step 12 is the first paid moment**, and it is a second person arriving rather than a
paywall. Everything before it works alone, on one laptop, with no network.

**Steps 13 and 14 are the moat.** Nothing else in the market is positioned to answer *should
this agent be allowed*, because answering it means holding all three realities at once.

**Step 15 is what a renewal is bought with.** Every step before it restricts. This one is
the only system in the building that can say, with evidence, that an agent can safely be
given more authority than it has.

## The one sentence

> **Memnox closes the gap between what AI agents can do, what they actually do, and what your
> organization intended them to do.**

And the progression a person walks:

```
WHAT CAN IT DO?
       ↓
WHAT IS IT DOING?
       ↓
WHY IS IT ALLOWED?
       ↓
WHAT IF WE GIVE IT MORE POWER?
```

Which is a great deal stronger than AI governance, AI security, AI memory or agent
monitoring. Those are four components of it. The pain is the loss of control and
understanding as AI becomes autonomous, and every situation above is one shape of it.

---

## The line between open and cloud

Drawn on a principle, not on a feature count, or every quarter is an argument.
**Everything one person needs to govern the agents on their own machine is open and works
with no account.** Anything that only means something across more than one person, and
that needs somebody else's data to work, is the cloud. That is why situations 01 to 17
need no account at all, and why the transition is a second person arriving rather than a
paywall.

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
- **A safety ranking across agent products.** Situation 32 decomposes into findings about
  *this machine*, which is honest. The same question answered as a league table of vendors
  is a claim about software nobody tested, and it is a comparison score by another name.
- **Refereeing a collision between two agents.** Situation 16 reports that two agents are
  in the same file, which is worth knowing. Opening the diff to decide which of them is
  right is code review: a different product, a different buyer, and out of scope
  permanently.
- **A share-of-changes chart.** Situation 53 answers per change, and that is the answer.
  *Forty one percent of production changes were made by an agent* is a dashboard tile
  answering a question nobody acts on.
- **Seventy tabs.** The product answers four questions. A console that needs a tour has
  stopped answering them.

## Four things that never ship

- **Doing the work.** No step writes the code or issues the refund. The moment it executes,
  it competes with every agent framework instead of governing them.
- **Another assistant.** The value is a shared operational reality other systems read. A
  chat box is an interface, never the product.
- **A copy of the business.** It understands and points. Becoming the system of record for
  everything is a five year migration nobody agreed to.
- **Silent automation.** Nothing acts without an accountable identity and a record. An
  unattributable action is exactly what this category will be judged on.

---

## The phase index

The build sequence is cited by number across all three repositories, from `CLAUDE.md`,
`CONTRIBUTING.md`, `CHANGELOG.md` and source comments. Those citations still resolve here.
A phase is the engineering that closes a group of situations above, and this table is the
mapping between the two.

| Phase | Owns | Closes |
|---|---|---|
| `§01` Discovery | what can act here, what it reaches, findings, reversible harden steps | 01, 03, 07, 11, 34, 35, 46 |
| `§02` Evidence | one normalized model, defined once, that every later phase writes into | 56 |
| `§03` Observation | seams, interception both ways, the ledger, frames, lineage | 12, 13, 14, 16, 36, 39, 40, 51 |
| `§04` Explain | the deterministic answer, built from the match and never from a model | 06, 22, 24, 25, 60 |
| `§05` Protect | policies, the three effects, proposals, simulation, native controls | 04, 05, 30, 31, 38 |
| `§06` Watch | configuration and behaviour drift, with the cause named | 02, 09, 10, 33, 55 |
| `§07` Repository evidence | CODEOWNERS, ADRs, AGENTS.md, branch rules, already on disk | 19, 20, 57 |
| `§08` Organizational evidence | Slack, Jira, Linear, Notion, Drive, and current state | 18, 26, 27, 28, 29, 48, 49, 58 |
| `§09` Policy candidates | the bridge from what was observed to what is enforced | 08, 41, 50 |
| `§10` Cloud | identity, the fleet, approvals, chains, evidence, autonomy | 15, 17, 21, 23, 32, 37, 42, 43, 44, 45, 47, 52, 53, 54, 59 |

**Why this order.** Discovery first, because a count read off the reader's own disk is the
only honest aggregate at minute zero. The model before the sources, which is why §07, §08
and §09 add evidence without a rewrite. Observation before enforcement, because a verdict
nobody is obliged to ask for is advice. Explanation before protection, because a block a
user cannot interrogate is a block they will disable. Native controls rather than a new
one. Evidence before policy, because a policy editor opened before there is traffic to
write about is a blank form. Repository before Slack, because level two evidence needs no
account. Confirmation before enforcement, always. Local before cloud, because the open
half's entire credibility is that nothing leaves the machine.
