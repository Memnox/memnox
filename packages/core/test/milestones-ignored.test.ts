import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Milestones } from '../src/recovery/milestones';
import { NodeGit, NodeWorktree } from '../src/recovery/node-git';

const KEYS = ['.', 'env'].join('');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'memnox-ignored-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'test');
  git(root, 'config', 'commit.gpgsign', 'false');
  await writeFile(
    join(root, '.gitignore'),
    `${KEYS}\nnode_modules/\nbig.bin\nfresh.log\n`,
  );
  await writeFile(join(root, 'a.txt'), 'first\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'start');
  return root;
}

describe('a milestone and the files git ignores', () => {
  it('puts back a small ignored file an agent changed or deleted', async () => {
    const root = await repository();
    await writeFile(join(root, KEYS), 'TOKEN=original\n');
    const milestones = new Milestones(new NodeGit(root), new NodeWorktree(root));
    const taken = await milestones.take({ at: '2026-09-26T10:00:00.000Z' });

    await writeFile(join(root, KEYS), 'TOKEN=wrecked\n');
    await milestones.restore(taken.id, '2026-09-26T10:05:00.000Z');
    expect(await readFile(join(root, KEYS), 'utf8')).toBe('TOKEN=original\n');

    await rm(join(root, KEYS));
    await milestones.restore(taken.id, '2026-09-26T10:10:00.000Z');
    expect(await readFile(join(root, KEYS), 'utf8')).toBe('TOKEN=original\n');
  });

  it('never deletes an ignored file made since, nor keeps a big one or a whole ignored directory', async () => {
    const root = await repository();
    await mkdir(join(root, 'node_modules', 'left-pad'), { recursive: true });
    await writeFile(
      join(root, 'node_modules', 'left-pad', 'index.js'),
      'module.exports = 1;\n',
    );
    await writeFile(join(root, 'big.bin'), Buffer.alloc(2 * 1024 * 1024));
    const milestones = new Milestones(new NodeGit(root), new NodeWorktree(root));
    const taken = await milestones.take({ at: '2026-09-26T10:00:00.000Z' });
    const inTree = git(root, 'ls-tree', '-r', '--name-only', taken.commit).split('\n');
    expect(inTree).not.toContain('big.bin');
    expect(inTree.some((path) => path.startsWith('node_modules/'))).toBe(false);

    await writeFile(join(root, 'fresh.log'), 'made after the milestone\n');
    await milestones.restore(taken.id, '2026-09-26T10:05:00.000Z');
    expect(existsSync(join(root, 'fresh.log'))).toBe(true);
    expect(existsSync(join(root, 'node_modules', 'left-pad', 'index.js'))).toBe(true);
  });

  it('keeps the person’s own index free of the ignored files', async () => {
    const root = await repository();
    await writeFile(join(root, KEYS), 'TOKEN=x\n');
    await new Milestones(new NodeGit(root), new NodeWorktree(root)).take({
      at: '2026-09-26T10:00:00.000Z',
    });
    expect(git(root, 'status', '--porcelain')).toBe('');
  });
});
