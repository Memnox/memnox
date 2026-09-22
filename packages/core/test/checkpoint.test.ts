import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AutoCheckpoints,
  FileCheckpointMarks,
  type CheckpointMarkStore,
} from '../src/recovery/auto-checkpoints';
import {
  CHECKPOINT_KIND,
  checkpointDue,
  DESTRUCTIVE_SPACING_MS,
  markTaken,
  type CheckpointMark,
  type CheckpointRequest,
} from '../src/recovery/checkpoint';
import { destructiveCommand, destructiveInLine } from '../src/recovery/destructive';
import { MILESTONE_REASON, milestonesOfSession } from '../src/recovery/milestone';
import { Milestones } from '../src/recovery/milestones';
import { NodeGit, NodeWorktree } from '../src/recovery/node-git';

const AT = '2026-09-24T10:00:00.000Z';

function request(over: Partial<CheckpointRequest> = {}): CheckpointRequest {
  return {
    kind: CHECKPOINT_KIND.FIRST_WRITE,
    sessionId: 'ses_a',
    agent: 'claude-code',
    place: '/repo',
    at: AT,
    ...over,
  };
}

function later(ms: number): string {
  return new Date(Date.parse(AT) + ms).toISOString();
}

describe('which commands destroy work', () => {
  it.each([
    [['rm', '-rf', 'src'], 'before rm -r src'],
    [['rm', 'notes.md'], 'before rm notes.md'],
    [['git', 'reset', '--hard', 'HEAD~1'], 'before git reset --hard'],
    [['git', '-C', 'app', 'clean', '-fd'], 'before git clean'],
    [['git', 'checkout', '--', '.'], 'before git checkout -- .'],
    [['git', 'restore', '.'], 'before git restore .'],
    [['mv', 'a', 'b', 'c', 'dest/'], 'before mv of 3 path(s)'],
    [['mv', 'src/*', 'old/'], 'before mv of 1 path(s)'],
  ])('%j is kept before', (argv, note) => {
    expect(destructiveCommand(argv)?.note).toBe(note);
  });

  it.each([
    [['rm']],
    [['git', 'clean', '-n']],
    [['git', 'restore', '--staged', 'a.ts']],
    [['git', 'checkout', 'main']],
    [['git', 'reset', 'HEAD']],
    [['mv', 'a', 'b']],
    [['ls', '-la']],
  ])('%j destroys nothing a milestone could keep', (argv) => {
    expect(destructiveCommand(argv)).toBeNull();
  });

  it('finds the destructive command anywhere in a line', () => {
    expect(destructiveInLine('npm test && git reset --hard')?.note).toBe(
      'before git reset --hard',
    );
    expect(destructiveInLine('echo hi | cat')).toBeNull();
  });
});

describe('when a checkpoint is due', () => {
  it('keeps the first write once per session and place', () => {
    const marks = markTaken([], request());
    expect(checkpointDue([], request())).toBe(true);
    expect(checkpointDue(marks, request({ at: later(60_000) }))).toBe(false);
    expect(checkpointDue(marks, request({ sessionId: 'ses_b' }))).toBe(true);
    expect(checkpointDue(marks, request({ place: '/other' }))).toBe(true);
  });

  it('spaces destructive checkpoints so a loop keeps one tree', () => {
    const marks = markTaken([], request());
    const destructive = { kind: CHECKPOINT_KIND.DESTRUCTIVE };
    expect(checkpointDue(marks, request({ ...destructive, at: later(1_000) }))).toBe(
      false,
    );
    expect(
      checkpointDue(
        marks,
        request({ ...destructive, at: later(DESTRUCTIVE_SPACING_MS) }),
      ),
    ).toBe(true);
  });

  it('remembers only the newest sessions', () => {
    let marks: CheckpointMark[] = [];
    for (let each = 0; each < 5; each += 1) {
      marks = markTaken(marks, request({ sessionId: `ses_${each}`, at: later(each) }), 3);
    }
    expect(marks.map((mark) => mark.sessionId)).toEqual(['ses_4', 'ses_3', 'ses_2']);
  });
});

class MemoryMarks implements CheckpointMarkStore {
  marks: CheckpointMark[] = [];
  async read(): Promise<CheckpointMark[]> {
    return this.marks;
  }
  async write(marks: readonly CheckpointMark[]): Promise<void> {
    this.marks = [...marks];
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'memnox-checkpoint-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'test');
  git(root, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(root, 'a.txt'), 'first\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'start');
  return root;
}

describe('checkpoints kept in a real repository', () => {
  it('keeps one milestone for a session, however many writes follow', async () => {
    const root = await repository();
    const checkpoints = new AutoCheckpoints({ marks: new MemoryMarks() });
    const first = await checkpoints.before(request({ place: root }));
    const second = await checkpoints.before(request({ place: root, at: later(5_000) }));

    expect(first?.reason).toBe(MILESTONE_REASON.FIRST_WRITE);
    expect(first?.agent).toBe('claude-code');
    expect(second).toBeNull();
    const listed = await new Milestones(new NodeGit(root), new NodeWorktree(root)).list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.sessionId).toBe('ses_a');
  });

  it('keeps one before a destructive command, and never for a path outside the repository', async () => {
    const root = await repository();
    const checkpoints = new AutoCheckpoints({ marks: new MemoryMarks() });
    const destructive = { kind: CHECKPOINT_KIND.DESTRUCTIVE, place: root };

    expect(await checkpoints.before(request(destructive), ['/tmp/elsewhere'])).toBeNull();
    const kept = await checkpoints.before(request(destructive), ['a.txt']);
    expect(kept?.reason).toBe(MILESTONE_REASON.DESTRUCTIVE);
  });

  it('prunes the oldest, keeping the newest few', async () => {
    const root = await repository();
    const checkpoints = new AutoCheckpoints({ marks: new MemoryMarks(), keep: 2 });
    for (let each = 0; each < 4; each += 1) {
      await checkpoints.before(
        request({ sessionId: `ses_${each}`, place: root, at: later(each * 1_000) }),
      );
    }
    const listed = await new Milestones(new NodeGit(root), new NodeWorktree(root)).list();
    expect(listed.map((one) => one.sessionId)).toEqual(['ses_3', 'ses_2']);
  });

  it('restores a session to before its first write', async () => {
    const root = await repository();
    const checkpoints = new AutoCheckpoints({ marks: new MemoryMarks() });
    await checkpoints.before(request({ place: root }));
    await writeFile(join(root, 'a.txt'), 'the agent was here\n');
    await writeFile(join(root, 'new.txt'), 'and here\n');

    const milestones = new Milestones(new NodeGit(root), new NodeWorktree(root));
    const [first] = milestonesOfSession(await milestones.list(), 'ses_a');
    await milestones.restore(first?.id ?? '', later(10_000));

    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('first\n');
    await expect(readFile(join(root, 'new.txt'), 'utf8')).rejects.toThrow();
  });

  it('writes its marks under the Memnox home, never into the repository', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-home-'));
    const root = await repository();
    const marks = new FileCheckpointMarks(home);
    await new AutoCheckpoints({ marks }).before(request({ place: root }));
    expect((await marks.read()).map((mark) => mark.place)).toEqual([root]);
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  it('is quick enough to sit in front of a write', async () => {
    const root = await repository();
    const checkpoints = new AutoCheckpoints({ marks: new MemoryMarks() });
    const started = Date.now();
    await checkpoints.before(request({ place: root }));
    const took = Date.now() - started;
    // A generous ceiling: a small repository measures in tens of milliseconds.
    expect(took).toBeLessThan(2_000);
    const skipped = Date.now();
    await checkpoints.before(request({ place: root, at: later(1) }));
    // Owing nothing starts no process at all.
    expect(Date.now() - skipped).toBeLessThan(50);
  });
});
