# @memnox/interceptors

## 0.13.2

### Patch Changes

- The question `memnox run` asks on the terminal is one card answered with the arrows and enter, or one number, with the command as typed, the reason said once, a live countdown, and the id to answer from anywhere. Escape and ctrl-c are a no, the command can be edited in place, and one line stays in the scrollback saying what was decided. The terminal is opened as a terminal, which is what makes a single key work.
- 278df61: An agent another agent started is held to that agent's rules as well as its own, so a child never does what its parent may not. Codex launched from Claude Code's shell, or an agent started under a nested `memnox run`, is ruled as itself and as every agent above it, the strictest answer winning, and a refusal that came from a parent names it. The chain is read from what the parent hands down, its own marker and the `MEMNOX_PARENT_AGENTS` that `memnox run` writes. A sub-agent Claude Code runs inside its own session was already ruled as Claude Code.
- 10e0423: A repository an agent clones starts on probation, because it is a stranger's code. From the `git clone` on, work inside it is contained as `memnox run --untrusted` contains a session: outward and destructive actions ask, and writes outside it ask, without anybody having to remember the flag. `memnox repo list` shows what is on probation and `memnox repo trust <path>` ends it once somebody has looked. It ends by itself after seven days, as an agent's or a server's does.
- 757e71d: A wrapped MCP server that dies under a working agent is said on the proxy's stderr and kept as a `config.drift.server-down` row with its exit code. One that ends cleanly, or that the agent itself stopped, is not news. `memnox doctor --servers` lists the servers that stopped in the last day above the ones it starts and asks.
- 2c8590c: A session only the hooks see can have a task. `memnox task set "<what the agent is here to do>" --paths src/payments` declares one for the repository you are in, for twelve hours unless `--hours` says otherwise, and any session working there without a task of its own takes it: actions outside the paths count as drift toward the circuit breaker, and a rule matching `scope = out_of_scope` fires. `memnox task show` and `memnox task clear` read and end it. Only `memnox run --task` could declare one before, and a hooked session's id is not something anybody knows.
- b54d3df: Typing `claude`, `codex` or `gemini` now starts it under `memnox run`, so the egress proxy, the kernel wall and the session's records come with it and nobody has to remember the command. Setup puts a small launcher for each agent CLI this machine has in the same directory as the interceptors. Inside a session it runs the real binary, so a run never starts itself again; `--version`, `--help`, `mcp`, `config`, `update`, `doctor`, `login` and `logout` go straight through; and `MEMNOX_LAUNCH=off` turns it off for one command. `memnox uninstall` removes them with the rest.
- ec909de: `memnox allow "railway.*" --env staging --for 30m --reason "reproducing the retry bug"` allows a scope for a while, so an agent working inside it is not asked at every step: one approval rather than thirty. It is narrowed by action, environment, target and agent, it only ever answers a question a rule would have asked and never overrules a refusal, it ends on its own and at most eight hours out, and every decision it makes says who allowed it and until when. `memnox allow --list` shows what is in force and `memnox allow --revoke <id>` ends one now.
- b1f1458: The daemon now says when an agent's authority grew between two of its passes: an agent that can now change a system with nobody asked, where before it could only read it; a CLI newly logged in on the machine, which any agent with a shell can then use; and a CLI whose credential now names something like production, such as a kubectl context called `prod-eu-1`. Each is a notice and a `config.drift.authority` row, the first pass only records what there is, and authority that narrowed is not news.
- 710da87: A shell command that writes several files takes a lease on each of them, so `touch a b`, `sed -i` across two directories or a redirect alongside them is withheld when another agent holds any of the paths, not only the first. Two leases one process took in the same millisecond shared an id and the second overwrote the first on disk; the id now carries the path.
- 19758d2: The MCP proxy classifies a call by what the server said about its tool when it listed it, so a `readOnlyHint` or a `destructiveHint` decides over a name that says something else, and a rule about changes reads the server's own word. Before the first listing it goes by the name, as it did.

  The first time an agent reaches a host through the egress proxy is a `network.first-destination` row, so a timeline shows when it began, and `memnox explain <agent>` lists the hosts it has reached with how often and since when.

- 60433f8: A session only the hooks see now trips the circuit breaker's scope drift. An allowed action outside the task declared for it, by `memnox task set` or `memnox run --task`, is reported to the daemon as drift and nothing else, so the breaker counts it toward its threshold without the action being charged to a budget or counted as work done.
- 9ae6524: Printing a key is ruled on as reading it. `env`, `printenv`, `export -p` and `set` print every variable, and `printenv NAME` or `echo $NAME` prints one, so each is an `environment.read` naming the variable, or `all`. Only a name that looks like a credential counts, and a key handed to `curl` is left to the egress check, since it is used there rather than shown. The generated rule about credential files covers these too.

  `gh api -X PUT repos/<owner>/<repo>/pulls/<n>/merge` is `gh.pr-merge`, so a rule about merging is not stepped around through the REST API.

- e6b7881: On Linux, the Landlock wall of `memnox run --untrusted` now leaves the repository's own `.env` files out of what it grants, to read and to write, since a Landlock write grant reads as well. They are found by name up to three directories down, never inside `node_modules`, `.git` or build output, and `.env.example`, `.env.sample` and `.env.template` stay granted.
- Cursor and Windsurf learn to ask what the workspace settled before they edit. Their hooks cannot add anything to a session, so `memnox-session` says it in the instructions every host reads when it connects.
- 847c05b: `memnox mode investigate` lets every agent on this machine read anything, files, repositories, logs, databases, APIs and MCP tools, and refuses every change outside the machine, pushes, and writes outside the workspace, with a way forward that says to report what it found. `memnox mode autonomous` lets the work through, edits, tests, commits, pushes and pull requests, and stops at moving money, deploying, handing out authority, deleting outside the machine and any change in an environment named like production. `memnox mode off` goes back to your own rules. A mode is a set of ordinary rules in `~/.memnox/mode.policies.toml`, so `why` and `policy test` explain it like any other.

  A task can be declared as an investigation, with `memnox task set "..." --intent investigate` or `memnox run --investigate`, and a change outside the machine is then refused with the ask quoted back. The summary at the end of a session now says how many changes landed outside the machine and how many a person approved.

- 25efef3: "Allow for this session" now holds for the rest of the session. The grant was kept in the memory of the process that heard the answer, and every hook and shell wrapper is its own process, so the next call was asked again. Grants are kept on disk under `~/.memnox/grants`, and cover the action the question named, so `gh.pr-view` allowed once for the session covers the next pull request viewed as well. A web request's grant covers that host and an MCP call's covers that server's tool. A delete is only ever granted for the exact call.

  The second yes to the same action in one session is the last one asked for, whether it was given in the terminal, from the workspace, or in the agent's own permission prompt, where the tool running is read as the yes. A delete is never learned this way, and a new session starts over.

- c432e3f: A shell line is split only where the shell splits it, so `psql -c "SELECT 1; DROP TABLE t"` is one statement that drops a table rather than a read followed by an unknown command. Every `-c` is read, and so is a heredoc or a here-string, a `DROP` of any object, `COPY ... FROM`, `SELECT ... INTO`, `DO`, `CALL` and `VACUUM`. A statement nothing recognises is a write, since a database session can do anything. `mongosh` is read by its method names, so `deleteMany({})` is every document and `find` is a read.

  Writes the shell makes are ruled on as writes: a redirect, `tee`, `touch`, `mkdir`, `sed -i`, `chmod`, `ln`, `truncate`, both ends of `mv` and the destination of `cp`, and `rmdir`, `unlink` and `shred` are deletes.

  Flags before the verb no longer hide it, so `kubectl --context prod delete`, `git -C dir push` and `aws --profile prod s3 rm` are the delete or push they are. `gh api -XPOST`, `--method=POST` and a lowercase method are writes, a GraphQL query is a read and a mutation a write, and an approving review is its own action. The `railway`, `stripe`, `npm`, `git`, `kubectl`, `terraform` and `docker` tables cover the verbs that were unknown and so let through, among them `railway redeploy`, `down` and `variables --set`, `stripe post`, `delete`, `trigger` and every resource's `create`, `update`, `confirm` and `capture`, and `npm ci`.

  An MCP tool named `rerun`, `cancel`, `redeploy`, `refund` or `approve` is a write, a name that opens with a read verb stays a read whatever noun follows, and a database tool is judged by the statement it was handed. `memnox policy test` and `memnox next` rule with each action's class, so a rule about changes no longer shows a read as refused, and `policy test --class` names one.

- `memnox rewind` typed by an agent is refused, so a rewind always goes through the session tool and a person saying yes. `memnox rewind --list` still works, so the agent can find a milestone id.
- 298d974: A milestone now keeps the small files git ignores, so a rewind puts back an ignored config or key file the agent changed or deleted. Only files of a megabyte or less are kept, at most two hundred, and a wholly ignored directory such as `node_modules` or `dist` is skipped without being walked. A rewind still never deletes an ignored file created since the milestone, and the person's own index never sees any of them. The contents are kept in this repository's `.git` under `refs/memnox/`, which no ordinary push sends anywhere.
- 51302eb: A rule's pattern can now leave things out: one starting with `!` takes matches back out, and `{workspace}` stands for the directory the agent is working in. So a rule can ask about every host but the ones a project talks to, and refuse a write anywhere but the workspace while the workspace goes through untouched, which an allow rule could never do because an ask or a deny beats it. A request that names no target or no working directory cannot be shown to be excluded, so the rule still applies to it. The hook now reports the working directory for file edits too.

  The generated rule about credential files leaves `.env.example`, `.env.sample` and `.env.template` readable, since a template holds names and no values. Claude Code's native permissions and the kernel wall cannot express an exclusion, so they stay the wider of the two.

- 78b400b: `psql -f query.sql` is ruled on by what the file holds, so a file of selects is a read under a read-only rule and one that drops a table is destructive. A file over half a megabyte, or one that will not read, leaves the command the write it was before.
- 8178240: A session is summed up when it ends, without anybody asking. `memnox run` prints one line after the agent exits: actions, files read and changed, reads and changes in the busiest systems, and what was stopped, with the command that shows the rest. A session only the hooks saw leaves the same line as a `session.summary` row when it ends, filed with the config rows so no count of agent work includes it.
- 5bc572d: A session's task is now what the person typed, without anybody declaring one. Each prompt is kept as the session's task, so `why` quotes the ask, and a prompt that reads as an investigation, "investigate why the payments failed", "look into the staging failure", or anything that says "do not change anything", holds the session to reading: a change outside this machine is refused and the agent is told so up front. A prompt that asks for a fix is not an investigation, a task a person declared with `memnox task set` or `memnox run --task` is never replaced by one read from a prompt, and it is read by its words, never by a model.

  A session only the hooks saw now shows its summary line as a desktop notice when it ends, since nobody is watching its terminal by then.

- 1873b63: A server that grows a tool that changes things is caught the moment it lists it. The MCP proxy keeps what each server listed last time under `~/.memnox/pins`, and a listing with a new tool that writes, deletes or sends, or an old one that started to, is said on the proxy's stderr and kept as a `config.drift.new-write-tool` row naming the tools and which of them no rule covers. `replay` shows it beside what the session did. The daemon still never starts a server; the proxy already talks to it.
- 8b83d27: A session that has only read other systems and then changes one is asked about once. After three reads through a CLI or an MCP tool and no change outside this machine, the first change there, such as a refund after looking at the payment, needs a person, because each step being allowed does not make "look into it" the same as "fix it". A web fetch is reading the docs and does not count toward it, and local work never does.

  `memnox doctor --servers` starts every MCP server an agent is configured with, as `memnox scan` does when asked, and says which answer and for which agents, since a server that is configured and does not answer is one an agent will fail on.

- bcbbd28: Inside an untrusted repository, a cloned one or one run with `--untrusted`, an MCP tool that changes something is refused rather than asked about, while reading through it still goes, and the repository's own `.env` files are refused while `.env.example`, `.env.sample` and `.env.template` stay readable. On macOS the kernel wall of `memnox run --untrusted` refuses those key files too, so a binary the agent runs cannot read them either. A CLI that reaches out still asks, as it did.
- c481f9b: A session becomes wary of what it read from any tool, not only an MCP one. When a fetched page, a file or a command's output addresses the model, such as "ignore previous instructions", the after-tool hook marks the session and what goes outward is asked about for the window, as an MCP result saying it already did. Memnox's own session tools never mark it.

  The circuit breaker now counts actions outside the task `memnox run --task --paths` declared, so its scope-drift trip can fire. Nothing reported them before, and the counter it reads stayed at zero.

- 9f4bbdb: A rule can name what a change does rather than only its class: `capabilities` matches `transfer` for anything that moves money, `deploy` for a deploy, a release, `kubectl apply` or `terraform apply`, `admin` for IAM, secrets, roles and invites, `execute` for code run somewhere else, and `delete`, `send`, `write` and `read`. It is read from the action's name and class, the same way for an MCP tool and a CLI verb, and a local command such as `git apply` stays a `write`. `memnox explain <server>` shows what each tool does in these words.
- d4a7575: `memnox report --session <id>` adds up one session, `last` for the latest: files read and changed, reads and changes in each system outside this machine, what was held and what was stopped. `memnox why` shows the task declared for the session and the three steps before the decision. `memnox replay` puts what changed on the machine, from an hour before the session until it ended, in order beside what the session did, so a server that gained a tool sits right before the agent calling it.

  `memnox explain <server>` shows what each tool would meet under the rules in force and which rule decides it, and `memnox explain <agent>` shows each system the agent reaches with its reads and its changes counted as allowed, asked, refused and covered by no rule. A server that disappears from an agent's config is now a notice, because what relied on it will fail, and a new server's notice says how many of its tools read, write and delete.

- 8e809aa: A rule's `environments` now matches. A command's environment is the one it names, as it names it: railway's `--environment`, kubectl's `--context`, aws's `--profile`, gcloud's `--project`, docker's `--context`, and `RAILWAY_ENVIRONMENT`, `AWS_PROFILE`, `TF_WORKSPACE` or `DOCKER_CONTEXT` where no flag says. `vercel --prod`, `netlify --prod` and `stripe --live` are `production`, and an MCP call names its own in an `environment`, `environmentName`, `env` or `stage` argument. Before this, no seam set an environment, so a rule naming one never fired.

  A refusal says which environment the command named, and where the rule only said to ask somebody it names the verb table's way forward for that command, such as `railway logs` for a refused `railway redeploy`. A shell command refused inside Claude Code's own shell tool now carries its way forward too, which it used to drop.

- What your workspace has settled reaches the agent in its session. Once a machine is connected, the daemon pulls the decisions, policies, owners and approval authorities in force beside the rules, with who confirmed each and when, into `~/.memnox/memory.json`. The agent is told at the start of a session to ask before it changes code, what was settled about a subject or a path is added when a prompt names it or just before the first write to it, and two new `memnox-session` tools answer on request: `memory` looks through what this machine holds, and `brief` asks the workspace live about the paths an agent is about to change. Matching is by shared words and paths on the machine, and none of it ever allows or refuses an action.
- Updated dependencies
- Updated dependencies [278df61]
- Updated dependencies [10e0423]
- Updated dependencies [757e71d]
- Updated dependencies [2c8590c]
- Updated dependencies [b54d3df]
- Updated dependencies [ec909de]
- Updated dependencies [b1f1458]
- Updated dependencies [710da87]
- Updated dependencies [19758d2]
- Updated dependencies [60433f8]
- Updated dependencies [9ae6524]
- Updated dependencies [e6b7881]
- Updated dependencies
- Updated dependencies [847c05b]
- Updated dependencies [25efef3]
- Updated dependencies [c432e3f]
- Updated dependencies
- Updated dependencies [298d974]
- Updated dependencies [51302eb]
- Updated dependencies [78b400b]
- Updated dependencies [8178240]
- Updated dependencies [5bc572d]
- Updated dependencies [1873b63]
- Updated dependencies [8b83d27]
- Updated dependencies [bcbbd28]
- Updated dependencies [c481f9b]
- Updated dependencies [9f4bbdb]
- Updated dependencies [d4a7575]
- Updated dependencies [8e809aa]
- Updated dependencies
  - @memnox/core@0.13.2

## 0.13.1

### Patch Changes

- 3ca11bc: Reading never waits on a person, and changing somebody else's system still does. A web fetch, a search, `curl` or `wget` without a body goes through, and a `POST`, `PUT`, `PATCH` or `DELETE` is asked about. An MCP tool that lists or reads goes through, and one that writes, deletes, sends a message or cannot be classified is asked about. The CLIs that act on a remote system, which are the cloud providers, `gh`, `kubectl`, `terraform`, the hosting platforms, `stripe`, the database clients, `docker push` and `npm publish`, are asked about for their writes and deletes and left alone for their reads, while installs, builds and test runs stay local work. Rules gain a `classes` field for this, and an `http.request` names its `method`.

  The `aws` table now reads an operation by its verb whatever the service, so `aws ec2 describe-instances` is a read and `create-`, `put-`, `update-`, `delete-` and the rest are changes, where before most of them matched nothing. `gh api` is a change when a method or a field says so, and the everyday `pr`, `issue`, `workflow` and `run` verbs are classified.

  A refused edit tells the agent that a yes in the conversation allows nothing and that the same write made another way is the same write, and says how its person can allow it.

- Updated dependencies [3ca11bc]
  - @memnox/core@0.13.1

## 0.13.0

### Minor Changes

- beee8d3: Protection can be turned off on purpose and on the record. `memnox stop` lets every seam through without ruling and keeps the daemon from putting hooks back, with `--for` to end it on time and `--reason` for the team; `memnox start` turns it back on in the mode it was stopped in. Both are ledger rows, `memnox status` shows the stop first, and an enrolled machine reports it to its workspace.

  A newly adopted agent or wrapped MCP server starts on probation for seven days: its writes, outward and destructive actions ask, and its reads do not. `memnox agents trust` and `memnox mcp trust` end a probation now. An agent that has been silent for thirty days while holding a write tool, a credential or a hook is shown as dormant.

  Memnox answers from inside the agent's own session. `memnox-session` is a local MCP server every installed agent launches, with `why`, `status`, `replay` and `decisions` to read the record and `rewind` as the one tool that acts, which always asks its person first. No tool can allow, approve or trust anything, because an agent that could call one would approve itself.

  A run can be held to its task with Landlock and edit containment, and the working tree is checkpointed before a destructive write so `memnox rewind` can put it back. `memnox replay` walks one session step by step, marking what led to a failure or a breaker trip.

  The daemon keeps the boundary setup drew and notices drift, raising a desktop notice and writing every config change to the ledger. Unusual actions are called out as they happen, and egress is served from the daemon.

  `memnox update` shows the installed and latest versions and upgrades with the command that matches how this copy was installed, after you say yes. Decisions, protection changes and actions now sync to the control plane behind a cursor, so nothing is sent twice.

### Patch Changes

- Updated dependencies [beee8d3]
  - @memnox/core@0.13.0

## 0.12.0

### Minor Changes

- c153c55: Two agents on two machines stop writing the same lines without either being told. An edit takes its lease from inside the agent through a hook, in Claude Code, Codex, Cursor, Gemini CLI and Windsurf, and the hook reads the lines and the function the edit is about to change, so two sessions in one file only meet where their edits do. Anything with no hook of its own, which is every other agent and a person in their own editor, is watched instead: the daemon claims the lines a saved file changed a moment after the save, says plainly that it could not stop that save, and tells the other side.

  Work that writes no path is claimed too. Posting the message, opening the issue, closing the pull request: the MCP proxy and the shell wrappers ask one register before the work goes out, so an agent here meets an agent there on the same issue rather than doing it twice. A claim lasts as long as the call and is let go the moment it returns.

  A refusal now names which lines are held, who holds them, whether they have gone quiet and when they free up, and it ends on the one thing a person can type, `memnox lock --free <id>`, which frees another machine's hold with the reason kept on the record. Where a person is at the session, Claude Code asks them in its own permission prompt instead of refusing.

  A running session is told while it works. The same hook collects what was said to that session at every pause and hands it to the agent beside the tool result, and the proxy does the same for an agent with no hooks, so the agent that got somewhere first hears about the collision in its own session. What it did is sent within a couple of seconds rather than on the next heartbeat.

  `memnox setup` wraps the MCP servers as part of the guided run and writes into each wrapped line which agent it belongs to, so a refusal names Claude Code or Cursor rather than "an agent".

### Patch Changes

- Updated dependencies [c153c55]
  - @memnox/core@0.12.0

## 0.11.0

### Minor Changes

- 7ed5b5c: `memnox setup` finishes the job it started: it enrols the machine and then wires it, putting the seams, a baseline rule set and the daemon in place, so the command the console tells somebody to run leaves no agent ungoverned behind a ticked step.

  Every command is drawn on one rail with a tone per line, which is what makes a refusal read differently from a result.

  A held answer travels back inside the window the agent is still waiting in, rather than after it has given up. The shell seam records what it decided and names which refusal it was, and a credential rule fires at the seam that reads the file rather than one layer above it. A lease is never recorded against a pid nothing can outlive, `doctor` names the two failures its count cannot see, and a conflict nobody is having is no longer reported.

### Patch Changes

- Updated dependencies [7ed5b5c]
  - @memnox/core@0.11.0

## 0.10.1

### Patch Changes

- @memnox/core@0.10.1

## 0.10.0

### Patch Changes

- Updated dependencies
  - @memnox/core@0.10.0

## 0.9.1

### Patch Changes

- Keep a workspace id out of sentences, and revoke what offboard says it revokes.

  A control plane that keys workspaces by UUID turned every prompt into
  `Call it something 789fdf81-0ecc-4d17-a234-464bc0a8ecf4 will recognise`, which
  is a sentence nobody reads to the end. The id now appears on the lines that
  state facts, where it can be copied, and prose says the workspace's name where
  there is one short enough to read and "your workspace" where there is not.

  `memnox agents offboard` restored an agent's config and then failed to revoke
  its credential, reporting only that it could not. The control plane refuses one
  machine acting on another's row, and an agent's row is not the laptop's, so the
  call never had a chance. A machine may now hand back the credentials of agents
  it enrolled itself, which is the same authority it used to mint them. Nothing
  else moved: it still cannot beat, sync or pull rules as one of its agents.

- Updated dependencies
  - @memnox/core@0.9.1

## 0.9.0

### Minor Changes

- One approval per machine, and one rail for the whole setup run.

  `memnox setup` sent you to a browser for every agent it onboarded, so a laptop
  with five agents asked for five approvals after you had already approved the
  laptop itself. Agents on this machine are now enrolled on the credential that
  first approval produced, through a door the control plane opens only to a
  machine acting for itself. Each agent still holds its own credential, so
  revoking one does not silence the others, and each records the machine that
  vouched for it, so revoking the laptop takes them all. Against a control plane
  that has no such door the browser flow still runs, and the screen says why one
  opened rather than leaving a tab to explain itself.

  Everything the run prints is on one rail now, prompts and enrolment included:
  enrolment had been writing to stdout while the rest drew on stderr, so the one
  step that can block on a person looked like another command interrupting, and
  anything piping `memnox` received it. Paths print under `~`, backup filenames
  are short enough to read, and every wait names its deadline. The approval poll
  now has a floor, because a control plane sending a zero interval left it
  polling as fast as the network would answer.

### Patch Changes

- Updated dependencies
  - @memnox/core@0.9.0

## 0.7.2

### Patch Changes

- @memnox/core@0.7.2

## 0.7.1

### Patch Changes

- 7d23156: The ledger's append-only trigger now holds what it claimed.

  It asked only whether `authorizedBy` moved the right way, so any `UPDATE` that
  set it could rewrite every other column in the same statement: one release of a
  held call could turn a denied action into an allowed one, under a different name
  and with a different reason, and SQLite raised nothing. `memnox why` reads those
  rows a year later, which is the whole reason the trigger exists. Migration 4
  recreates it so that nothing except `authorizedBy` may change, and a test holds
  the guarded column list against the table itself so a column added later cannot
  slip out from under it.

  The git credential seam now carries an allow list rather than a deny list.
  `protocol`, `host`, `path` and `username` are what naming a remote needs; every
  other field git sends is dropped unread. The old list named `password` and
  `credential`, which was right for the protocol as it stood and wrong as a shape,
  since the block is extensible and already carries `oauth_refresh_token`. What
  the seam carries reaches the ledger, so a list of what is safe is the only shape
  that cannot be outgrown.

- Updated dependencies [7d23156]
  - @memnox/core@0.7.1

## 0.7.0

### Patch Changes

- Updated dependencies [451aa4e]
  - @memnox/core@0.7.0

## 0.4.1

### Patch Changes

- Updated dependencies [8c92a70]
  - @memnox/core@0.4.1

## 0.4.0

### Patch Changes

- Updated dependencies [8530156]
  - @memnox/core@0.4.0

## 0.2.1

### Patch Changes

- Updated dependencies [f99aca0]
  - @memnox/core@0.2.1
