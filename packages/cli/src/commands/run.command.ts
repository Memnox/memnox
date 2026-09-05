import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { delimiter } from 'node:path';
import type { Command } from 'commander';
import { interceptorDirFor } from '@memnox/interceptors';
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
  ) => Promise<number>;
  home?: () => string;
  newId?: () => string;
}

const defaultStart = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<number> =>
  new Promise((resolve) => {
    const child = spawn(command, [...args], { stdio: 'inherit', env });
    // The agent's exit code is the caller's; a wrapper that swallowed it would lie.
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(127));
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
    .action(async (command: string[], options: { shell: string }) => {
      const binary = command[0];
      if (binary === undefined) {
        throw new Error('Name the command to run:  memnox run -- claude');
      }

      const home = (deps.home ?? homedir)();
      const sessionId = (deps.newId ?? newSessionId)();
      const env = environmentFor(process.env, home, sessionId, options.shell);

      context.out.note(`session ${sessionId}`);
      context.out.note(`interceptors on PATH from ${interceptorDirFor(home)}`);

      const start = deps.start ?? defaultStart;
      const code = await start(binary, command.slice(1), env);
      process.exitCode = code;
    });
}
