import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AutoCheckpoints,
  MILESTONE_REASON,
  Milestones,
  NodeGit,
  NodeWorktree,
  type CheckpointMark,
  type CheckpointMarkStore,
} from '@memnox/core';
import {
  checkpointBeforeCommand,
  checkpointBeforeFirstWrite,
  checkpointBeforeLine,
  type CheckpointScene,
} from '../src/checkpoint-seam';

const AT = Date.parse('2026-09-24T10:00:00.000Z');

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'memnox-seam-checkpoint-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'test');
  git(root, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(root, 'a.txt'), 'first\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'start');
  return root;
}

async function scene(
  root: string,
  clock: { ms: number },
  logged: string[] = [],
): Promise<CheckpointScene> {
  return {
    home: await mkdtemp(join(tmpdir(), 'memnox-seam-home-')),
    sessionId: 'ses_claude',
    agent: 'claude-code',
    place: root,
    now: () => new Date(clock.ms),
    log: (message) => logged.push(message),
  };
}

function kept(root: string): Promise<{ reason: string; note?: string }[]> {
  return new Milestones(new NodeGit(root), new NodeWorktree(root)).list();
}

describe('the milestones a seam keeps on its own', () => {
  it('keeps one before the first write of a session, and none for the writes after', async () => {
    const root = await repository();
    const clock = { ms: AT };
    const here = await scene(root, clock);

    expect(await checkpointBeforeFirstWrite(here)).not.toBeNull();
    clock.ms += 60_000;
    expect(await checkpointBeforeFirstWrite(here)).toBeNull();

    const listed = await kept(root);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.reason).toBe(MILESTONE_REASON.FIRST_WRITE);
    expect(listed[0]?.note).toBe('before claude-code first wrote here');
  });

  it('keeps one before a destructive command, spaced so a loop keeps one', async () => {
    const root = await repository();
    const clock = { ms: AT };
    const here = await scene(root, clock);

    expect(await checkpointBeforeCommand(here, ['git', 'status'])).toBeNull();
    const first = await checkpointBeforeCommand(here, ['rm', '-rf', 'a.txt']);
    clock.ms += 1_000;
    const again = await checkpointBeforeLine(here, 'git reset --hard');

    expect(first?.reason).toBe(MILESTONE_REASON.DESTRUCTIVE);
    expect(first?.note).toBe('before rm -r a.txt');
    expect(again).toBeNull();
    clock.ms += 60_000;
    expect(
      await checkpointBeforeLine(here, 'npm test && git reset --hard'),
    ).not.toBeNull();
  });

  it('logs a milestone it could not keep and lets the agent go on', async () => {
    const logged: string[] = [];
    const broken: CheckpointMarkStore = {
      read: async (): Promise<CheckpointMark[]> => {
        throw new Error('disk full');
      },
      write: async () => undefined,
    };
    const here = await scene('/nowhere', { ms: AT }, logged);

    const result = await checkpointBeforeFirstWrite({
      ...here,
      checkpoints: new AutoCheckpoints({ marks: broken }),
    });

    expect(result).toBeNull();
    expect(logged[0]).toContain('disk full');
  });

  it('keeps nothing outside a repository', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'memnox-no-repo-'));
    expect(await checkpointBeforeFirstWrite(await scene(outside, { ms: AT }))).toBeNull();
  });
});
