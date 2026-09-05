import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, release } from 'node:os';
import { randomUUID } from 'node:crypto';
import { delimiter } from 'node:path';
import type { Command } from 'commander';
import {
  guardFor,
  MEMNOX_HOME,
  MILESTONE_REASON,
  Milestones,
  OS_GUARD,
  sandboxCommand,
} from '@memnox/core';
import { FALLBACK_SHELL, interceptorDirFor, REAL_SHELL_VAR } from '@memnox/interceptors';
import type { CliContext } from '../cli-context';
import { NodeGit, NodeWorktree } from '../node-git';

export const SESSION_VAR = 'MEMNOX_SESSION';

/**
 * Everything the child needs to be governed, set as environment rather than asked of
 * the agent: PATH so the interceptors are found first, SHELL so its `Bash` tool goes
 * through one, the shell we displaced so that wrapper has something to hand off to, and
 * a session id so one piece of work reads as one timeline.
 */
export function environmentFor(
  base: NodeJS.ProcessEnv,
  home: string,
  sessionId: string,
  shellBinary: string,
): NodeJS.ProcessEnv {
  const interceptors = interceptorDirFor(home);
  const path = base['PATH'] ?? '';
  return {
    ...base,
    PATH: path.startsWith(interceptors) ? path : `${interceptors}${delimiter}${path}`,
    SHELL: shellBinary,
    /* The shell we displace, so the wrapper has something to hand the command to and
       never reads `SHELL` back to find itself. */
    [REAL_SHELL_VAR]: base['SHELL'] ?? FALLBACK_SHELL,
    [SESSION_VAR]: sessionId,
  };
}

function newSessionId(): string {
  return `ses_${randomUUID().slice(0, 12)}`;
}

interface RunDeps {
  /** Injected so a test never writes a ref into the repository it is running in. */
  milestones?: () => Milestones;
  /** Injected so a test drives the real command body without starting a process. */
  start?: (
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
    transcript?: string,
  ) => Promise<number>;
  home?: () => string;
  newId?: () => string;
}

export function transcriptPathFor(home: string, sessionId: string): string {
  return join(home, MEMNOX_HOME, 'transcripts', `${sessionId}.log`);
}

const defaultStart = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  transcript?: string,
): Promise<number> =>
  new Promise((resolve) => {
    if (transcript === undefined) {
      const child = spawn(command, [...args], { stdio: 'inherit', env });
      // The agent's exit code is the caller's; a wrapper that swallowed it would lie.
      child.on('exit', (code) => resolve(code ?? 1));
      child.on('error', () => resolve(127));
      return;
    }

    /* Teed rather than intercepted: the agent's output still reaches the terminal
       unchanged, and a copy lands on this disk for `memnox why` to check a claim
       against. It never leaves the machine, and retention drops it with everything else. */
    mkdirSync(join(transcript, '..'), { recursive: true, mode: 0o700 });
    const log = createWriteStream(transcript, { mode: 0o600 });
    const child = spawn(command, [...args], {
      stdio: ['inherit', 'pipe', 'pipe'],
      env,
    });
    child.stdout?.pipe(process.stdout);
    child.stdout?.pipe(log);
    child.stderr?.pipe(process.stderr);
    child.stderr?.pipe(log);
    child.on('exit', (code) => {
      log.end();
      resolve(code ?? 1);
    });
    child.on('error', () => {
      log.end();
      resolve(127);
    });
  });

export function registerRunCommand(
  program: Command,
  context: CliContext,
  deps: RunDeps = {},
): void {
  program
    .command('run')
    .description('Start an agent with the interceptors, the proxy and a session in place')
    .argument('<command...>', 'the agent command, after --')
    .option('--shell <path>', 'shell the agent should use', 'memnox-shell')
    .option(
      '--transcript',
      'keep a local copy of what the agent printed, so a claim can be checked against the record',
    )
    .option('--no-guard', 'start outside the kernel sandbox even when a profile exists')
    .option('--no-milestone', 'do not keep the working tree before the agent starts')
    .action(
      async (
        command: string[],
        options: {
          shell: string;
          transcript?: boolean;
          guard?: boolean;
          milestone?: boolean;
        },
      ) => {
        const binary = command[0];
        if (binary === undefined) {
          throw new Error('Name the command to run:  memnox run -- claude');
        }

        const home = (deps.home ?? homedir)();
        const sessionId = (deps.newId ?? newSessionId)();
        const env = environmentFor(process.env, home, sessionId, options.shell);

        context.out.note(`session ${sessionId}`);
        context.out.note(`interceptors on PATH from ${interceptorDirFor(home)}`);

        /* Taken before a single command runs, because the point is the willingness to
           let it run unsupervised — and that only exists if the way back is already
           there when somebody realises they need it. */
        if (options.milestone !== false) {
          const kept = await keepMilestone(sessionId, binary, deps);
          if (kept !== null) {
            context.out.note(`working tree kept as ${kept} — "memnox rewind" undoes it`);
          }
        }

        /* The kernel guard, when one was written and this platform takes it. It is a
           second line, not the gate: without it a binary that never saw a wrapper can
           still read a denied file. */
        const guarded = sandboxed(command, home, options.guard !== false);
        if (guarded !== command) context.out.note('inside the sandbox profile');

        const transcript =
          options.transcript === true ? transcriptPathFor(home, sessionId) : undefined;
        if (transcript !== undefined) context.out.note(`transcript ${transcript}`);

        const start = deps.start ?? defaultStart;
        const [executable, ...args] = guarded;
        const code = await start(executable ?? binary, args, env, transcript);
        process.exitCode = code;
      },
    );
}

interface GuardSeams {
  exists?: (path: string) => boolean;
  platform?: string;
  kernel?: string;
}

/** Wraps the command in `sandbox-exec` when a profile is there and the platform takes it. */
export function sandboxed(
  command: readonly string[],
  home: string,
  wanted: boolean,
  seams: GuardSeams = {},
): readonly string[] {
  if (!wanted) return command;
  const platform = seams.platform ?? process.platform;
  const kernel = seams.kernel ?? release();
  if (guardFor(platform, kernel).guard !== OS_GUARD.SEATBELT) return command;
  const profile = join(home, MEMNOX_HOME, 'guard', 'memnox.sb');
  if (!(seams.exists ?? existsSync)(profile)) return command;
  return sandboxCommand(profile, command);
}

/**
 * Best effort, and quiet about it: not being in a repository is the ordinary case for
 * somebody running an agent in a scratch directory, and it must not stop the agent.
 */
async function keepMilestone(
  sessionId: string,
  binary: string,
  deps: RunDeps,
): Promise<string | null> {
  try {
    const milestones =
      deps.milestones === undefined
        ? new Milestones(new NodeGit(process.cwd()), new NodeWorktree(process.cwd()))
        : deps.milestones();
    const taken = await milestones.take({
      at: new Date().toISOString(),
      reason: MILESTONE_REASON.SESSION,
      sessionId,
      note: `before ${binary}`,
    });
    return taken.id;
  } catch {
    return null;
  }
}
