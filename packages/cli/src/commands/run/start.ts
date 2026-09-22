/**
 * Starting the agent and saying what is around it: the process with its exit code passed
 * back, the transcript teed beside the terminal, and the interceptors row on the screen.
 */
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { interceptorDirFor } from '@memnox/interceptors';
import type { CliContext } from '../../cli-context';
import type { FlowRow } from '../../flow';

/** What is actually in the interceptor directory. Empty when there is no directory. */
export function interceptorsIn(home: string): readonly string[] {
  try {
    return readdirSync(interceptorDirFor(home));
  } catch {
    // Not there, which is the same answer as empty: nothing on PATH will be wrapped.
    return [];
  }
}

export function wiringRow(
  context: CliContext,
  home: string,
  installed: (home: string) => readonly string[],
): FlowRow {
  const wrappers = installed(home);
  if (wrappers.length > 0) {
    return {
      label: 'interceptors',
      value: `${wrappers.length} on PATH from ${interceptorDirFor(home)}`,
    };
  }
  return {
    label: 'interceptors',
    value: context.style.warn(
      'none installed, so shell and git commands are not gated. "memnox protect --interceptors" installs them',
    ),
  };
}

export function defaultStart(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  transcript?: string,
): Promise<number> {
  return new Promise((resolve) => {
    if (transcript === undefined) {
      const child = spawn(command, [...args], { stdio: 'inherit', env });
      // The agent's exit code is the caller's; a wrapper that swallowed it would lie.
      child.on('exit', (code) => resolve(code ?? 1));
      child.on('error', () => resolve(127));
      return;
    }

    // Teed rather than intercepted: the terminal sees it unchanged and a local copy stays for claims.
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
}
