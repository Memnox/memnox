import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOOK_MARKER, installGitHooks, removeGitHooks } from '../src/git-hooks';

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'memnox-hooks-'));
  await mkdir(join(dir, '.git', 'hooks'), { recursive: true });
  return dir;
}

const hookPath = (dir: string, name: string): string => join(dir, '.git', 'hooks', name);

describe('git hooks, as the second line', () => {
  it('installs both, and each one stops the operation on a non-zero', async () => {
    const dir = await repo();
    const report = await installGitHooks(dir);

    expect(report.installed).toEqual(['pre-push', 'pre-commit']);
    const push = await readFile(hookPath(dir, 'pre-push'), 'utf8');
    expect(push).toContain('memnox policy test "git.push"');
    expect(push).toContain('exit 1');
  });

  it('never overwrites a hook somebody else wrote, and says which it skipped', async () => {
    const dir = await repo();
    await writeFile(hookPath(dir, 'pre-push'), '#!/bin/sh\necho theirs\n');

    const report = await installGitHooks(dir);
    expect(report.skipped.map((each) => each.hook)).toEqual(['pre-push']);
    expect(report.installed).toEqual(['pre-commit']);
    expect(await readFile(hookPath(dir, 'pre-push'), 'utf8')).toContain('echo theirs');
  });

  it('replaces its own hook on a re-install, rather than skipping it', async () => {
    const dir = await repo();
    await installGitHooks(dir);
    const report = await installGitHooks(dir);
    expect(report.installed).toHaveLength(2);
    expect(report.skipped).toEqual([]);
  });

  it('removes only its own, so somebody else’s survives', async () => {
    const dir = await repo();
    await writeFile(hookPath(dir, 'pre-push'), '#!/bin/sh\necho theirs\n');
    await installGitHooks(dir);

    const removed = await removeGitHooks(dir);
    expect(removed).toEqual(['pre-commit']);
    expect(await readFile(hookPath(dir, 'pre-push'), 'utf8')).toContain('echo theirs');
  });

  it('marks what it wrote, so removal never has to guess', async () => {
    const dir = await repo();
    await installGitHooks(dir);
    expect(await readFile(hookPath(dir, 'pre-commit'), 'utf8')).toContain(HOOK_MARKER);
  });

  it('tells a reader how to undo it, in the file itself', async () => {
    const dir = await repo();
    await installGitHooks(dir);
    expect(await readFile(hookPath(dir, 'pre-push'), 'utf8')).toContain(
      'memnox uninstall',
    );
  });
});
