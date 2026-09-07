---
'memnox': patch
'@memnox/core': patch
---

A workspace can move a machine along the autonomy ramp, and a machine says what it is
actually running.

Two halves of the same fact, and neither existed. `VISION.md` `I.6` is progressive
autonomy: observe, then ask, then trusted. Nothing could move a machine along it from
the control plane, and the console could only ever show the mode a workspace had *asked*
for, which on a box somebody had edited was the request rather than the state.

- **The heartbeat reports the mode this machine is running**, read from its own
  `config.toml` rather than assumed from what was last sent. The mode is applied here,
  and somebody at the keyboard may have changed it, so the fleet page can now show the
  request and the state apart instead of showing one and calling it the other.
- **A change graduates a machine; a repetition is silent.** The reply carries the
  workspace's mode on every pass, so a machine that wrote it each time would revert an
  edit somebody made on purpose, within a minute, for ever — and `config.toml` says
  "yours to edit" at the top. `Account.cloudMode` records what was last heard, so only a
  genuine change lands. The same shape as the bundle, which applies on a changed hash and
  costs a 304 otherwise.
- **Both directions.** Going up the ramp is the point; going back down is the valve
  somebody needs when a rule set breaks the build at two in the morning. Making that the
  one thing you have to SSH to every box for is how it gets done by uninstalling instead.
- **Best effort, and last.** A machine that cannot write its own config still beats,
  still holds, and still enforces whatever it already had — and its next beat reports the
  mode it is genuinely running, so the drift is visible in the console rather than silent.
