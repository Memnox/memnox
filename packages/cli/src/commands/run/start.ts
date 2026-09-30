/**
 * Starting the agent and saying what is around it: the process with its exit code passed
 * back, the transcript teed beside the terminal, and the interceptors row on the screen.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, readdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { Readable, Transform } from 'node:stream';

import { interceptorDirFor } from '@memnox/interceptors';
import type { CliContext } from '../../cli-context';
import type { FlowRow } from '../../flow';
import { maskEach } from './transcript';

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
  if (transcript === undefined) return startPlain(command, args, env);
  return startTeed(command, args, env, transcript);
}

function startPlain(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { stdio: 'inherit', env });
    // The agent's exit code is the caller's; a wrapper that swallowed it would lie.
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(127));
  });
}

/** Teed rather than intercepted: the terminal sees it unchanged and a masked copy stays for claims. */
function startTeed(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  transcript: string,
): Promise<number> {
  mkdirSync(join(transcript, '..'), { recursive: true, mode: 0o700 });
  const log = createWriteStream(transcript, { mode: 0o600 });
  const child = spawn(command, [...args], { stdio: ['inherit', 'pipe', 'pipe'], env });
  child.stdout?.pipe(process.stdout);
  child.stderr?.pipe(process.stderr);
  return teedExitCode(
    child,
    log,
    maskEach(log, [child.stdout, child.stderr].filter(isReadable)),
  );
}

/**
 * The code, once the file has closed and not before: every mask has to flush into it
 * first, or the last lines the agent printed are cut off the transcript.
 */
function teedExitCode(
  child: ChildProcess,
  log: WriteStream,
  masks: readonly Transform[],
): Promise<number> {
  return new Promise((resolve) => {
    let code = 1;
    // The masks and the child itself: the file closes once all of them are done with it.
    let waiting = masks.length + 1;
    const done = (): void => {
      waiting -= 1;
      if (waiting === 0) log.end();
    };
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    log.once('close', settle);
    log.once('error', settle);
    for (const mask of masks) mask.once('end', done);
    // A missing command fires `error` and then `close` with -2, so the child counts
    // once here and the first code it named is the one kept.
    let named = false;
    const childDone = (next: number): void => {
      if (named) return;
      named = true;
      code = next;
      done();
    };
    // `close` rather than `exit`: the streams can still be draining when the process goes.
    child.on('close', (exit) => childDone(exit ?? 1));
    child.on('error', () => {
      // Nothing will end these now, and a mask left open is a run that never returns.
      for (const mask of masks) if (!mask.writableEnded) mask.end();
      childDone(127);
    });
  });
}

function isReadable(stream: Readable | null): stream is Readable {
  return stream !== null;
}
