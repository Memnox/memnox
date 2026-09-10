import { describe, expect, it } from 'vitest';
import type { EnvironmentSnapshot } from '@memnox/core';
import { registerAgentsCommand } from '../src/commands/agents.command';
import { runCommand } from './cli-harness';
import { FakeMachine, MemorySnapshots, fakeSeams } from './machine-harness';

/**
 * The agents on this machine, and the channel to them.
 *
 * `list` and `status` are local on purpose: the console answers what the whole
 * fleet runs, because only something holding every machine's reports can, and
 * answering it from here would mean widening what a machine credential reaches.
 */

const HOME = '/home/dev';

function snapshotWith(agents: EnvironmentSnapshot['agents']): EnvironmentSnapshot {
  return { takenAt: '2026-01-01T00:00:00.000Z', agents, servers: [], resources: [] };
}

function withKept(snapshot?: EnvironmentSnapshot) {
  const snapshots = new MemorySnapshots();
  if (snapshot !== undefined) snapshots.kept.push(snapshot);
  const seams = fakeSeams(FakeMachine.from({}), { snapshots });
  return { snapshots, seams };
}

const run = (args: string[], seams: ReturnType<typeof fakeSeams>, home: string = HOME) =>
  runCommand(
    (program, context) =>
      registerAgentsCommand(
        program,
        context,
        () => home,
        () => seams,
      ),
    args,
  );

describe('listing the agents on this machine', () => {
  it('names each one and what it is', async () => {
    const { seams } = withKept(
      snapshotWith([
        { id: 'claude-code', kind: 'harness', surfaces: [] },
        { id: 'cursor', kind: 'editor', version: '0.42', surfaces: [] },
      ]),
    );

    const { out } = await run(['agents', 'list'], seams);

    expect(out.text).toContain('claude-code (harness)');
    expect(out.text).toContain('cursor (editor 0.42)');
  });

  it('says the machine has not been scanned rather than that it has no agents', async () => {
    /* Two very different answers. One means run a scan; the other means this
       machine is clean, and reading the first as the second is how somebody
       concludes they are governed when nothing has looked. */
    const { seams } = withKept();

    const { out } = await run(['agents', 'list'], seams);

    expect(out.text).toContain('not been scanned');
    expect(out.notes.join('\n')).toContain('memnox agents discover');
  });

  it('says plainly when a scan found nothing', async () => {
    const { seams } = withKept(snapshotWith([]));

    const { out } = await run(['agents', 'list'], seams);

    expect(out.text).toContain('No agents found');
  });

  it('reads the kept scan rather than taking a fresh one', async () => {
    /* A scan starts every MCP server it finds. Listing is the thing somebody
       runs twice in a row, and making it the expensive one is how it stops
       being run. */
    const { snapshots, seams } = withKept(
      snapshotWith([{ id: 'claude-code', kind: 'harness', surfaces: [] }]),
    );

    await run(['agents', 'list'], seams);

    expect(snapshots.kept).toHaveLength(1);
  });

  it('answers as data when asked to', async () => {
    const { seams } = withKept(
      snapshotWith([{ id: 'claude-code', kind: 'harness', surfaces: [] }]),
    );

    const { out } = await run(['agents', 'list', '--json'], seams);

    const answer = JSON.parse(out.text);
    expect(answer.agents).toHaveLength(1);
    expect(answer.takenAt).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('one agent on this machine', () => {
  it('names where each surface was proved, not how many there are', async () => {
    /* A count says how much this agent reaches; the path says who granted it,
       which is the half somebody can act on. */
    const { seams } = withKept(
      snapshotWith([
        {
          id: 'claude-code',
          kind: 'harness',
          surfaces: [{ kind: 'mcp', detectedFrom: '/home/dev/.claude.json' }],
        },
      ]),
    );

    const { out } = await run(['agents', 'status', 'claude-code'], seams);

    expect(out.notes.join('\n')).toContain('/home/dev/.claude.json');
  });

  it('says no such agent rather than showing an empty one', async () => {
    const { seams } = withKept(
      snapshotWith([{ id: 'claude-code', kind: 'harness', surfaces: [] }]),
    );

    const { out } = await run(['agents', 'status', 'nowhere'], seams);

    expect(out.text).toContain('No agent called "nowhere"');
  });

  it('answers null as data rather than throwing', async () => {
    const { seams } = withKept();

    const { out } = await run(['agents', 'status', 'nowhere', '--json'], seams);

    expect(JSON.parse(out.text)).toEqual({ agent: null });
  });
});

describe('collecting what an operator said', () => {
  it('says nobody can have said anything when this machine is not logged in', async () => {
    /* Not an error. A machine with no account reaches nothing at all, which is
       the state the front page promises and the one most machines are in. */
    const { seams } = withKept(
      snapshotWith([{ id: 'claude-code', kind: 'harness', surfaces: [] }]),
    );

    const { out } = await run(['agents', 'control'], seams, '/home/nobody');

    expect(out.text).toContain('Not logged in');
    expect(out.notes.join('\n')).toContain('memnox login');
  });
});
