# @memnox/interceptors

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
