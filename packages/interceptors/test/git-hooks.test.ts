import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ownProcessEnv } from '@memnox/core';
import { HOOK_MARKER, installGitHooks, removeGitHooks } from '../src/git-hooks';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: ownProcessEnv(), encoding: 'utf8' });
}

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'memnox-hooks-'));
  git(dir, ['init', '-q']);
  return dir;
}

const hookPath = (dir: string, name: string): string => join(dir, '.git', 'hooks', name);

describe('git hooks, as the second line', () => {
  it('installs both, and each one stops the operation on a non-zero', async () => {
    const dir = await repo();
    const report = await installGitHooks(dir);

    expect(report.installed).toEqual(['pre-push', 'pre-commit']);
    const push = await readFile(hookPath(dir, 'pre-push'), 'utf8');
    /* The force push, not every push: the baseline denies one and allows the other,
       so a hook asking about `git.push` blocked nothing it was installed for. */
    expect(push).toContain('policy test "git.push-force"');
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

describe('a hook that cannot run Memnox', () => {
  /* Installing Memnox and then opening a shell without it on PATH — which is every
     shell, after `npx memnox` — stopped every commit in the repository, with
     "memnox: command not found" and nothing else. A hook that ruled on nothing must
     not block: 126 and 127 are the shell saying it never ran. */
  it('gets out of the way rather than blocking every commit', async () => {
    const dir = await repo();
    await installGitHooks(dir, '/definitely/not/here/memnox');

    const body = await readFile(join(dir, '.git', 'hooks', 'pre-commit'), 'utf8');
    expect(body).toContain('127');
    expect(body).toContain('126');
    expect(body).toContain('ruled on nothing');
  });

  it('falls back to the name on PATH before giving up', async () => {
    const dir = await repo();
    await installGitHooks(dir, '/opt/memnox/bin/memnox');

    const body = await readFile(join(dir, '.git', 'hooks', 'pre-commit'), 'utf8');
    // The path it was installed from, so it works in a shell that never heard of it.
    expect(body).toContain('/opt/memnox/bin/memnox');
    expect(body).toContain('MEMNOX=memnox');
  });
});

describe('what pre-push actually rules on', () => {
  /* The baseline denies a force push and allows an ordinary one, so a hook asking
     about `git.push` blocked nothing it was installed to block. */
  it('asks about the force push, not about every push', async () => {
    const dir = await repo();
    await installGitHooks(dir);

    const body = await readFile(join(dir, '.git', 'hooks', 'pre-push'), 'utf8');
    expect(body).toContain('git.push-force');
    expect(body).not.toContain('policy test "git.push"');
  });

  it('reads the rewrite off the refs, since git names no flag', async () => {
    const dir = await repo();
    await installGitHooks(dir);

    const body = await readFile(join(dir, '.git', 'hooks', 'pre-push'), 'utf8');
    expect(body).toContain('merge-base --is-ancestor');
    // A fast-forward is not a rewrite, and must never reach the rule.
    expect(body).toContain('[ "$forced" = "0" ] && exit 0');
  });

  it('leaves pre-commit alone, which has no refs to read', async () => {
    const dir = await repo();
    await installGitHooks(dir);

    const body = await readFile(join(dir, '.git', 'hooks', 'pre-commit'), 'utf8');
    expect(body).toContain('git.commit');
    expect(body).not.toContain('merge-base');
  });
});

describe('where git actually looks for a hook', () => {
  /* The directory was assumed to be `.git/hooks`, so a hook written under Husky was
     one git never ran, and a worktree, whose `.git` is a file, failed with ENOTDIR. */
  it('installs into a linked worktree, where `.git` is a file', async () => {
    const main = await repo();
    const identity = ['-c', 'user.name=t', '-c', 'user.email=t@example.com'];
    git(main, [...identity, 'commit', '-q', '--allow-empty', '-m', 'root']);
    const linked = join(await mkdtemp(join(tmpdir(), 'memnox-hooks-wt-')), 'linked');
    git(main, ['worktree', 'add', '-q', linked]);

    const report = await installGitHooks(linked);
    expect(report.installed).toEqual(['pre-push', 'pre-commit']);
    // Worktrees share the common directory's hooks, which is where git runs them from.
    expect(existsSync(hookPath(main, 'pre-commit'))).toBe(true);
    expect(await removeGitHooks(linked)).toEqual(['pre-push', 'pre-commit']);
  });

  it('leaves a hook framework directory alone and says why', async () => {
    const dir = await repo();
    git(dir, ['config', 'core.hooksPath', '.husky']);

    const report = await installGitHooks(dir);
    expect(report.installed).toEqual([]);
    expect(report.skipped.map((each) => each.hook)).toEqual(['pre-push', 'pre-commit']);
    expect(report.skipped[0]?.because).toContain('core.hooksPath');
    expect(existsSync(join(dir, '.husky'))).toBe(false);
    expect(existsSync(hookPath(dir, 'pre-commit'))).toBe(false);
  });

  it('installs nothing where there is no repository', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memnox-hooks-bare-'));
    expect(await installGitHooks(dir)).toEqual({ installed: [], skipped: [] });
    expect(existsSync(join(dir, '.git'))).toBe(false);
  });
});

describe('an install path the shell would otherwise read', () => {
  it('runs a binary whose path holds a space, a dollar and quotes', async () => {
    const dir = await repo();
    const bin = join(
      await mkdtemp(join(tmpdir(), 'memnox-hooks-bin-')),
      `my $HOME "it's"`,
    );
    await mkdir(bin);
    const binary = join(bin, 'memnox');
    const marker = join(dir, 'ran');
    await writeFile(binary, `#!/bin/sh\necho "$@" >> '${marker}'\nexit 0\n`);
    await chmod(binary, 0o755);

    await installGitHooks(dir, binary);
    execFileSync('sh', [hookPath(dir, 'pre-commit')], { cwd: dir, env: ownProcessEnv() });
    expect(await readFile(marker, 'utf8')).toContain('policy test git.commit');
  });
});
