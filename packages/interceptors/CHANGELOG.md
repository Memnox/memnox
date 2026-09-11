# @memnox/interceptors

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
