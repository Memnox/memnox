# @memnox/core

## 0.2.1

### Minor Changes

- f99aca0: Six commands were run against a real machine rather than a fixture, and this is what
  that found.

  - **Half the commands read one rule file and reported the machine as ungoverned.**
    `explain`, `policy test`, `autopilot` and `next` resolved the file in the current
    directory and stopped there, while `check`, `scan` and the daemon read the registry
    that names every repository on the disk. A laptop with two registered rule files was
    told "no rules here, nothing would stop it" by one command and shown a rule by
    another. All of them read the same set now, loaded file by file so one stale file
    never blanks the rest, and each names what would not load instead of leaving a
    missing rule silent.
  - **`memnox policy check --fix` rewrites the effects this version renamed.** A file
    written against the old vocabulary fails to load on `block` and `require_approval`
    alone, and the error already said what to write instead: `"block" is now "deny"`.
    Knowing the answer and making somebody apply it by hand to every rule is how a
    machine ends up with no rules in force at all. It rewrites the effect values as text,
    so comments and ordering survive, keeps the original under `~/.memnox/backup/`, and
    is never automatic: a rule file is a security control.
  - **One screen gave two different counts for one file.** The credentials block reported
    every credential as readable by every agent found, because it stood in the agent
    total instead of counting reach, while the block underneath counted properly. The
    same `~/.ssh/id_ed25519` read "5 agents" and "4 agents" four lines apart. Both read
    off the same table now, and a test pins them to each other. A reader who catches two
    numbers for one file stops believing both.
  - **The test suite wrote git refs into whatever repository it ran in.** `memnox run`
    takes a milestone, and the tests exercising it never stubbed one, so every `pnpm
test` committed four trees into `refs/memnox/` of the working checkout. Retention
    only ever ran when somebody typed `rewind --forget`, so they accumulated: nine
    hundred refs, and a `rewind --list` nobody could read. The tests state their own
    milestones now and retention applies where the milestone is made.
  - **`memnox run` set up a session for an agent that was not installed.** It took a
    milestone, declared the task and entered the sandbox before discovering there was no
    binary, and the refusal arrived as `sandbox-exec: execvp() ... No such file or
directory` over a working tree it had just kept for a run that never started. The
    binary is checked first now, and where the name is an agent kind whose executable is
    called something else, the message says so: the scan prints `claude-code` and the
    thing that starts is `claude`.
  - **The wordmark is drawn above every command, not only `login`.** On stderr and only
    for a decorated stream, so a pipe still receives the payload alone and `--json`
    suppresses it entirely.
  - **`memnox mcp wrap` printed a Node deprecation warning over its own output.** It
    asked a shell whether a binary was on PATH; it walks PATH itself now.
  - **Four screens said less.** `why` printed `an agent (agent)`; `doctor` repeated the
    path it had just given; `check` printed one identical reason on eleven rows and
    called eleven unruled actions "nothing would stop", where no rule covering an action
    is a different fact from a rule allowing it; `skills` printed seventy rows. `login`
    against a host with no enrolment endpoint reported a 404 as a refusal, which sends
    somebody to argue about a permission when the address is simply wrong.
