import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import {
  AutoCheckpoints,
  CHECKPOINT_KIND,
  Milestones,
  NodeGit,
  NodeWorktree,
  SessionPauses,
  SqliteEventStore,
  type CheckpointMark,
  type MemnoxEvent,
  type Milestone,
} from '@memnox/core';
import { CliContext } from '../src/cli-context';
import { RecordedOutput } from '../src/cli-output';
import { plainStyle } from '../src/style';
import { registerReplayCommand } from '../src/commands/replay.command';
import { registerRewindCommand } from '../src/commands/rewind.command';

const NOW = new Date('2026-09-24T12:00:00.000Z');

function event(id: string, minute: number, over: Partial<MemnoxEvent> = {}): MemnoxEvent {
  return {
    id,
    schemaVersion: 1,
    at: `2026-09-24T10:${String(minute).padStart(2, '0')}:00.000Z`,
    sessionId: 'ses_1',
    agent: 'claude-code',
    actorType: 'agent',
    surface: 'shell',
    operation: 'npm.test',
    class: 'read',
    effect: 'allow',
    mode: 'enforce',
    reason: 'no rule matched',
    ...over,
  };
}

async function machine(events: MemnoxEvent[]): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'memnox-replay-'));
  const store = SqliteEventStore.forHome(home);
  for (const each of events) await store.append(each);
  store.close();
  return home;
}

async function replay(
  home: string,
  args: string[],
  milestones: Milestone[] = [],
): Promise<RecordedOutput> {
  const out = new RecordedOutput();
  const program = new Command();
  registerReplayCommand(program, new CliContext(out, plainStyle), {
    home: () => home,
    cwd: () => home,
    now: () => NOW,
    milestonesAt: async () => milestones,
  });
  await program.parseAsync(['replay', ...args], { from: 'user' });
  return out;
}

describe('memnox replay', () => {
  it('steps through the latest session and marks what came before its failure', async () => {
    const home = await machine([
      event('old', 1, { sessionId: 'ses_0' }),
      event('a', 2),
      event('boom', 3, { operation: 'npm.build', exitCode: 1 }),
    ]);
    const out = await replay(home, ['--last']);

    expect(out.text).toContain('ses_1');
    expect(out.text).toContain('> allow  npm.build, exit 1');
    expect(out.text).toContain('It ended on a failure');
    expect(out.text).not.toContain('ses_0');
  });

  it('names a breaker trip and the milestone kept before the first write', async () => {
    const home = await machine([event('a', 2), event('b', 4, { exitCode: 2 })]);
    await new SessionPauses(home).pause({
      sessionId: 'ses_1',
      signal: 'error-loop',
      reason: 'the same failure five times',
      reached: 5,
      ceiling: 5,
      pausedAt: '2026-09-24T10:05:00.000Z',
    });
    const milestone: Milestone = {
      id: 'mst_first',
      commit: 'abc',
      takenAt: '2026-09-24T10:01:00.000Z',
      reason: 'first-write',
      sessionId: 'ses_1',
      files: 3,
    };
    const out = await replay(home, ['ses_1'], [milestone]);

    expect(out.text).toContain('milestone mst_first kept');
    expect(out.text).toContain('breaker tripped on error-loop');
    expect(out.text).toContain('The breaker paused it');
  });

  it('prints the replay itself under --json', async () => {
    const home = await machine([event('a', 2)]);
    const out = await replay(home, ['ses_1', '--json']);
    const parsed = JSON.parse(out.text) as { sessionId: string; steps: unknown[] };
    expect(parsed.sessionId).toBe('ses_1');
    expect(parsed.steps).toHaveLength(1);
  });

  it('refuses plainly when nothing was ever recorded', async () => {
    await expect(replay(await machine([]), [])).rejects.toThrow('Nothing recorded yet');
  });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'memnox-rewind-session-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'test');
  git(root, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(root, 'a.txt'), 'first\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'start');
  return root;
}

class MemoryMarks {
  marks: CheckpointMark[] = [];
  async read(): Promise<CheckpointMark[]> {
    return this.marks;
  }
  async write(marks: readonly CheckpointMark[]): Promise<void> {
    this.marks = [...marks];
  }
}

async function rewind(root: string, args: string[]): Promise<RecordedOutput> {
  const out = new RecordedOutput();
  const program = new Command();
  registerRewindCommand(program, new CliContext(out, plainStyle), {
    build: (cwd) => new Milestones(new NodeGit(cwd), new NodeWorktree(cwd)),
    cwd: () => root,
    now: () => NOW.toISOString(),
  });
  await program.parseAsync(['rewind', ...args], { from: 'user' });
  return out;
}

describe('memnox rewind to a session', () => {
  it('goes back to before the session first changed anything', async () => {
    const root = await repository();
    const checkpoints = new AutoCheckpoints({ marks: new MemoryMarks() });
    const request = {
      sessionId: 'ses_agent',
      agent: 'claude-code',
      place: root,
    };
    await checkpoints.before({
      ...request,
      kind: CHECKPOINT_KIND.FIRST_WRITE,
      at: '2026-09-24T10:00:00.000Z',
    });
    await writeFile(join(root, 'a.txt'), 'first edit\n');
    await checkpoints.before({
      ...request,
      kind: CHECKPOINT_KIND.DESTRUCTIVE,
      at: '2026-09-24T10:05:00.000Z',
    });
    await writeFile(join(root, 'a.txt'), 'the agent was here\n');

    const listed = await rewind(root, ['--list']);
    expect(listed.text).toContain('claude-code, ses_agent');

    const out = await rewind(root, ['--last']);
    expect(out.text).toContain('Working tree back to');
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('first\n');
  });

  it('says so when no milestone belongs to the session named', async () => {
    const root = await repository();
    await expect(rewind(root, ['--session', 'ses_none'])).rejects.toThrow(
      'No milestone here belongs to session ses_none',
    );
  });
});
