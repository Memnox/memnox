import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitDiff } from '../src/git-diff';

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', args, { cwd, encoding: 'utf8' });
};

const commit = async (repo: string, file: string, body: string): Promise<void> => {
  await writeFile(join(repo, file), body, 'utf8');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', file);
};

describe('gitDiff', () => {
  let repo: string;
  let previous: string;

  beforeEach(async () => {
    previous = process.cwd();
    repo = await mkdtemp(join(tmpdir(), 'memnox-diff-'));
    git(repo, 'init', '-q', '.');
    process.chdir(repo);
  });

  afterEach(async () => {
    process.chdir(previous);
    await rm(repo, { recursive: true, force: true });
  });

  it('scans the whole tree when there is no commit before HEAD', async () => {
    await commit(repo, 'a.ts', 'export const a = 1;\n');

    const result = gitDiff({});

    // A first commit and a depth=1 shallow clone both lack HEAD~1. Failing here
    // would break the build; scanning nothing would pass it having checked nothing.
    expect(result.base).toContain('no commit before HEAD');
    expect(result.diff).toContain('a.ts');
  });

  it('diffs against the previous commit once there is one', async () => {
    await commit(repo, 'a.ts', 'export const a = 1;\n');
    await commit(repo, 'b.ts', 'export const b = 2;\n');

    const result = gitDiff({});

    expect(result.base).toBe('HEAD~1');
    expect(result.diff).toContain('b.ts');
    expect(result.diff).not.toContain('a.ts');
  });

  it('names a ref that does not exist rather than silently using another base', async () => {
    await commit(repo, 'a.ts', 'export const a = 1;\n');

    expect(() => gitDiff({ base: 'release-9.9' })).toThrow(/release-9\.9/);
  });

  it('reports the staged changes as its base', async () => {
    await commit(repo, 'a.ts', 'export const a = 1;\n');
    await writeFile(join(repo, 'c.ts'), 'export const c = 3;\n', 'utf8');
    git(repo, 'add', '-A');

    const result = gitDiff({ staged: true });

    expect(result.base).toBe('the staged changes');
    expect(result.diff).toContain('c.ts');
  });
});
