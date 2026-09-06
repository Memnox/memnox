import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, release } from 'node:os';
import { randomUUID } from 'node:crypto';
import { delimiter } from 'node:path';
import type { Command } from 'commander';
import {
  guardFor,
  isEmptyScope,
  LeaseRegistry,
  MILESTONE_REASON,
  Milestones,
  OS_GUARD,
  sandboxCommand,
  SESSION_VAR,
  SessionTasks,
  taskFor,
  type DeclaredScope,
  type SessionTask,
} from '@memnox/core';
import {
  ENV_AGENT_ROLE as AGENT_ROLE_VAR,
  FALLBACK_SHELL,
  interceptorDirFor,
  REAL_SHELL_VAR,
} from '@memnox/interceptors';
import type { CliContext } from '../cli-context';
import { guardProfilePath, transcriptPathFor } from '../memnox-paths';
import { NodeGit, NodeWorktree } from '../node-git';

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
  now?: () => Date;
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
    .option('--task <statement>', 'what you actually asked for, in your words')
    .option('--paths <globs>', 'paths the task covers, comma separated')
    .option('--repos <list>', 'repositories the task covers, comma separated')
    .option('--services <list>', 'services the task covers, comma separated')
    .option('--envs <list>', 'environments the task covers, comma separated')
    .option('--expect <count>', 'roughly how many actions this should take')
    .option('--role <name>', 'the job this agent is enrolled under, matched by roles:')
    .action(
      async (
        command: string[],
        options: {
          shell: string;
          transcript?: boolean;
          guard?: boolean;
          milestone?: boolean;
          task?: string;
          paths?: string;
          repos?: string;
          services?: string;
          envs?: string;
          expect?: string;
          role?: string;
        },
      ) => {
        const binary = command[0];
        if (binary === undefined) {
          throw new Error('Name the command to run:  memnox run -- claude');
        }

        const home = (deps.home ?? homedir)();
        const sessionId = (deps.newId ?? newSessionId)();
        const env = environmentFor(process.env, home, sessionId, options.shell);
        if (options.role !== undefined) env[AGENT_ROLE_VAR] = options.role;

        context.out.note(`session ${sessionId}`);
        context.out.note(`interceptors on PATH from ${interceptorDirFor(home)}`);

        /* Written before the agent starts, because everything that can say "this went
           somewhere it was not asked to go" compares against a declaration. Nothing
           infers one: a session with no task is undeclared, never in violation. */
        const declared = await declareTask(home, sessionId, options, deps);
        if (declared !== null) {
          context.out.note(`task "${declared.statement}"`);
          if (declared.expectedActions !== undefined) {
            context.out.note(`expecting about ${declared.expectedActions} actions`);
          }
        }

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
        try {
          process.exitCode = await start(executable ?? binary, args, env, transcript);
        } finally {
          /* Rule 3 from the other end: a session that has ended cannot still be holding
             a path, whatever its lease said about expiry. In a `finally`, because an
             agent that crashed is exactly the one whose paths must not stay held. */
          const let_go = await releaseLeases(home, sessionId, deps);
          if (let_go > 0) {
            context.out.note(`released ${let_go} lease${let_go === 1 ? '' : 's'}`);
          }
        }
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
  const profile = guardProfilePath(home);
  if (!(seams.exists ?? existsSync)(profile)) return command;
  return sandboxCommand(profile, command);
}

/**
 * The task, when one was given. Every dimension is optional and an omitted one is
 * undeclared rather than empty — a task that declared paths says nothing about
 * environments, and reporting the second as drift would be an invention.
 */
async function declareTask(
  home: string,
  sessionId: string,
  options: {
    task?: string;
    paths?: string;
    repos?: string;
    services?: string;
    envs?: string;
    expect?: string;
  },
  deps: RunDeps,
): Promise<SessionTask | null> {
  const scope: DeclaredScope = {
    ...listOf('paths', options.paths),
    ...listOf('repositories', options.repos),
    ...listOf('services', options.services),
    ...listOf('environments', options.envs),
  };
  if (options.task === undefined && isEmptyScope(scope)) return null;

  const expected =
    options.expect === undefined ? undefined : Number.parseInt(options.expect, 10);
  if (expected !== undefined && (Number.isNaN(expected) || expected < 1)) {
    throw new Error('--expect takes a count, e.g. --expect 40');
  }

  const task = taskFor(
    sessionId,
    options.task ?? 'unstated',
    scope,
    (deps.now ?? (() => new Date()))().toISOString(),
    expected,
  );
  await new SessionTasks(home).declare(task);
  return task;
}

function listOf<TKey extends string>(
  key: TKey,
  value: string | undefined,
): Partial<Record<TKey, string[]>> {
  if (value === undefined) return {};
  const items = value
    .split(',')
    .map((each) => each.trim())
    .filter((each) => each.length > 0);
  return items.length === 0 ? {} : ({ [key]: items } as Record<TKey, string[]>);
}

/** Quiet on failure: a register that cannot be written must not stop an agent exiting. */
async function releaseLeases(
  home: string,
  sessionId: string,
  deps: RunDeps,
): Promise<number> {
  try {
    const registry = new LeaseRegistry(home);
    const released = await registry.releaseSession(
      sessionId,
      (deps.now ?? (() => new Date()))().toISOString(),
    );
    return released.length;
  } catch {
    return 0;
  }
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
