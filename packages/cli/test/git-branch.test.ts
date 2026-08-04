import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readBranch } from '../src/git-branch';

describe('readBranch', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'memnox-branch-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const withHead = async (contents: string, at: string = dir): Promise<void> => {
    await mkdir(join(at, '.git'), { recursive: true });
    await writeFile(join(at, '.git', 'HEAD'), contents, 'utf8');
  };

  it('reads the checked-out branch', async () => {
    await withHead('ref: refs/heads/main\n');

    expect(readBranch(dir)).toBe('main');
  });

  it('keeps the full name of a namespaced branch', async () => {
    await withHead('ref: refs/heads/release/24.3\n');

    expect(readBranch(dir)).toBe('release/24.3');
  });

  it('finds the repository from a nested working directory', async () => {
    await withHead('ref: refs/heads/main\n');
    const nested = join(dir, 'services', 'api');
    await mkdir(nested, { recursive: true });

    expect(readBranch(nested)).toBe('main');
  });

  it('follows the pointer file a worktree uses', async () => {
    const repo = join(dir, 'repo');
    const worktree = join(dir, 'wt');
    await mkdir(worktree, { recursive: true });
    await mkdir(join(repo, 'worktrees', 'wt'), { recursive: true });
    await writeFile(
      join(repo, 'worktrees', 'wt', 'HEAD'),
      'ref: refs/heads/feature/x\n',
      'utf8',
    );
    await writeFile(
      join(worktree, '.git'),
      `gitdir: ${join(repo, 'worktrees', 'wt')}\n`,
      'utf8',
    );

    expect(readBranch(worktree)).toBe('feature/x');
  });

  it('reports no branch on a detached HEAD', async () => {
    await withHead('9fceb02d0ae598e95dc970b74767f19372d61af8\n');

    expect(readBranch(dir)).toBeUndefined();
  });

  it('reports no branch outside a repository, and never throws', async () => {
    expect(readBranch(dir)).toBeUndefined();
    expect(readBranch(undefined)).toBeUndefined();
    expect(readBranch('')).toBeUndefined();
  });
});
