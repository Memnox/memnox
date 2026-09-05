import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { delimiter } from 'node:path';
import type { Command } from 'commander';
import { MEMNOX_HOME } from '@memnox/core';
import {
  FALLBACK_SHELL,
  interceptorDirFor,
  REAL_SHELL_VAR,
} from '@memnox/interceptors';
import type { CliContext } from '../cli-context';

export const SESSION_VAR = 'MEMNOX_SESSION';

/**
 * Everything the child needs to be governed, set as environment rather than asked of
 * the agent: PATH so the interceptors are found first, SHELL so its `Bash` tool goes through
 * one, the proxy variables so egress is observable, and a session id so one piece of
 * work reads as one timeline.
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
    .action(
      async (command: string[], options: { shell: string; transcript?: boolean }) => {
        const binary = command[0];
        if (binary === undefined) {
          throw new Error('Name the command to run:  memnox run -- claude');
        }

        const home = (deps.home ?? homedir)();
        const sessionId = (deps.newId ?? newSessionId)();
        const env = environmentFor(process.env, home, sessionId, options.shell);

        context.out.note(`session ${sessionId}`);
        context.out.note(`interceptors on PATH from ${interceptorDirFor(home)}`);

        const transcript =
          options.transcript === true ? transcriptPathFor(home, sessionId) : undefined;
        if (transcript !== undefined) context.out.note(`transcript ${transcript}`);

        const start = deps.start ?? defaultStart;
        const code = await start(binary, command.slice(1), env, transcript);
        process.exitCode = code;
      },
    );
}
