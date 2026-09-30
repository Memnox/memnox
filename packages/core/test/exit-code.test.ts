import { spawn } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EXIT,
  exitCodeForChild,
  exitCodeForSignal,
  exitCodeForSpawnError,
} from '../src/index';

/** Runs a real child and reports it the way the seams do. */
function exitOf(executable: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(executable, [...args], { stdio: 'ignore' });
    child.on('error', (err: unknown) => resolve(exitCodeForSpawnError(err)));
    child.on('exit', (code, signal) => resolve(exitCodeForChild(code, signal)));
  });
}

describe('exit codes for a child', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'memnox-exit-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports any signal as 128 plus its number, never as a refusal', () => {
    expect(exitCodeForSignal('SIGKILL')).toBe(137);
    expect(exitCodeForSignal('SIGSEGV')).toBe(139);
    expect(exitCodeForSignal('SIGTERM')).toBe(143);
    expect(exitCodeForChild(null, 'SIGPIPE')).not.toBe(EXIT.WITHHELD);
  });

  it('passes a code through, and a child with neither code nor signal failed', () => {
    expect(exitCodeForChild(3, null)).toBe(3);
    expect(exitCodeForChild(null, null)).toBe(EXIT.FAILED);
  });

  it('reports a child killed by SIGKILL as 137', async () => {
    expect(await exitOf('/bin/sh', ['-c', 'kill -KILL $$'])).toBe(137);
  });

  it('reports a missing binary as 127 and one it cannot execute as 126', async () => {
    expect(await exitOf(join(dir, 'missing'), [])).toBe(EXIT.NOT_FOUND);
    const locked = join(dir, 'locked');
    await writeFile(locked, '#!/bin/sh\n');
    await chmod(locked, 0o644);
    expect(await exitOf(locked, [])).toBe(EXIT.NOT_EXECUTABLE);
  });

  it('reports a spawn error it does not recognise as an ordinary failure', () => {
    expect(exitCodeForSpawnError(new Error('boom'))).toBe(EXIT.FAILED);
    expect(exitCodeForSpawnError('not an error')).toBe(EXIT.FAILED);
  });
});
