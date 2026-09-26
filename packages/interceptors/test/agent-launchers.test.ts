import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installInterceptors } from '../src/interceptor-install';

async function fake(dir: string, name: string, says: string): Promise<void> {
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\necho "${says} $*"\n`);
  await chmod(path, 0o755);
}

async function machine(): Promise<{ home: string; path: string }> {
  const home = await mkdtemp(join(tmpdir(), 'memnox-launch-'));
  const real = join(home, 'real-bin');
  await mkdir(real, { recursive: true });
  await fake(real, 'claude', 'real claude');
  await fake(real, 'memnox', 'memnox');
  const report = await installInterceptors(home, 'memnox-intercept', { path: real });
  expect(report.launchers).toEqual(['claude']);
  return { home, path: `${report.directory}:${real}:/usr/bin:/bin` };
}

function typed(path: string, args: string[], extra: NodeJS.ProcessEnv = {}): string {
  const result = spawnSync('claude', args, {
    env: { PATH: path, ...extra },
    encoding: 'utf8',
  });
  return result.stdout.trim();
}

describe('typing an agent by name', () => {
  it('starts it under memnox run', async () => {
    const { path } = await machine();
    expect(typed(path, ['fix the bug'])).toBe('memnox run -- claude fix the bug');
  });

  it('runs the real one inside a session, so the run does not start itself again', async () => {
    const { path } = await machine();
    expect(typed(path, ['x'], { MEMNOX_SESSION: 'ses_1' })).toBe('real claude x');
  });

  it('runs the real one for a command that starts no session, or when switched off', async () => {
    const { path } = await machine();
    expect(typed(path, ['--version'])).toBe('real claude --version');
    expect(typed(path, ['mcp', 'list'])).toBe('real claude mcp list');
    expect(typed(path, ['x'], { MEMNOX_LAUNCH: 'off' })).toBe('real claude x');
  });
});
