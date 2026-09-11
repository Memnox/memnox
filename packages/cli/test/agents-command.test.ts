import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EnvironmentSnapshot } from '@memnox/core';
import { chooseCloudName, registerAgentsCommand } from '../src/commands/agents.command';
import type { NameAsker } from '../src/agents/name-prompt';
import { readNames } from '../src/agents/names';
import { CliContext } from '../src/cli-context';
import { RecordedOutput } from '../src/cli-output';
import { runCommand } from './cli-harness';
import { FakeMachine, HOME, MemorySnapshots, fakeSeams } from './machine-harness';

/**
 * The agents on this machine, and what a person calls them.
 *
 * `list`, `status` and `name` are local on purpose: the console answers what the
 * whole fleet runs, because only something holding every machine's reports can,
 * and answering it from here would mean widening what a machine credential
 * reaches. A name is local for a second reason, which is that it is one person's
 * vocabulary and a fleet cannot hold two of them.
 */

function snapshotWith(agents: EnvironmentSnapshot['agents']): EnvironmentSnapshot {
  return { takenAt: '2026-01-01T00:00:00.000Z', agents, servers: [], resources: [] };
}

/** The shape the detectors actually produce: the id is built out of the product. */
const CLAUDE = { id: 'agt_claude-code', kind: 'claude-code', surfaces: [] };
const CURSOR = { id: 'agt_cursor', kind: 'cursor', version: '0.42', surfaces: [] };

/** A machine the detectors actually find something on, so `discover` has work to do. */
const HOSTING = {
  [`${HOME}/.claude.json`]: JSON.stringify({
    mcpServers: { github: { command: 'npx', args: ['github-mcp'] } },
  }),
  [`${HOME}/.cursor/mcp.json`]: JSON.stringify({ mcpServers: {} }),
};

describe('the agents on this machine', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'memnox-agents-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function withKept(snapshot?: EnvironmentSnapshot) {
    const snapshots = new MemorySnapshots();
    if (snapshot !== undefined) snapshots.kept.push(snapshot);
    return { snapshots, seams: fakeSeams(FakeMachine.from({}), { snapshots }) };
  }

  /** A scan that finds real agents, for the commands that take one themselves. */
  function hosting() {
    const snapshots = new MemorySnapshots();
    return { snapshots, seams: fakeSeams(FakeMachine.from(HOSTING), { snapshots }) };
  }

  const run = (
    args: string[],
    seams: ReturnType<typeof fakeSeams>,
    ask: NameAsker = async () => null,
    interactive = false,
  ) =>
    runCommand(
      (program, context) =>
        registerAgentsCommand(
          program,
          context,
          () => home,
          () => seams,
          ask,
          () => interactive,
        ),
      args,
    );

  describe('listing them', () => {
    it('calls each one what the product is called, not what its id is', async () => {
      /* `agt_claude-code` is the identity a ledger row is keyed on and it has to
         stay that. It is not the thing to put in a column somebody reads. */
      const { seams } = withKept(snapshotWith([CLAUDE, CURSOR]));

      const { out } = await run(['agents', 'list'], seams);

      expect(out.text).toContain('Claude Code');
      expect(out.text).toContain('Cursor');
      expect(out.text).not.toContain('agt_claude-code');
    });

    it('says whether each one is actually working under Memnox yet', async () => {
      const { seams } = withKept(snapshotWith([CLAUDE]));

      const { out } = await run(['agents', 'list'], seams);

      expect(out.text).toContain('not onboarded');
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
      const { snapshots, seams } = withKept(snapshotWith([CLAUDE]));

      await run(['agents', 'list'], seams);

      expect(snapshots.kept).toHaveLength(1);
    });

    it('carries the chosen name into the data, so nothing has to guess it back', async () => {
      const { seams } = withKept(snapshotWith([CLAUDE]));
      await run(['agents', 'name', 'claude-code', 'Backend Coder'], seams);

      const { out } = await run(['agents', 'list', '--json'], seams);

      const answer = JSON.parse(out.text);
      expect(answer.agents[0].name).toBe('Backend Coder');
      expect(answer.agents[0].id).toBe('agt_claude-code');
    });
  });

  describe('naming one', () => {
    it('takes the name a person chose and prints it everywhere afterwards', async () => {
      const { seams } = withKept(snapshotWith([CLAUDE]));

      await run(['agents', 'name', 'claude-code', 'Backend Coder'], seams);
      const { out } = await run(['agents', 'list'], seams);

      expect(out.text).toContain('Backend Coder');
      expect(await readNames(home)).toEqual({ 'agt_claude-code': 'Backend Coder' });
    });

    it('answers to the name it was given, not only to its id', async () => {
      /* Somebody who renamed an agent is going to type the name back. Failing
         there would teach them the rename was cosmetic. */
      const { seams } = withKept(snapshotWith([CLAUDE]));
      await run(['agents', 'name', 'agt_claude-code', 'Backend Coder'], seams);

      const { out } = await run(['agents', 'status', 'backend coder'], seams);

      expect(out.text).toContain('BACKEND CODER');
    });

    it('refuses a name another agent already answers to', async () => {
      /* Two agents called "Backend" makes every later command ambiguous, and the
         place to catch that is the one moment a person is choosing. */
      const { seams } = withKept(snapshotWith([CLAUDE, CURSOR]));
      await run(['agents', 'name', 'claude-code', 'Backend'], seams);

      const { out } = await run(['agents', 'name', 'cursor', 'Backend'], seams);

      expect(out.notes.join('\n')).toContain('agt_claude-code is already called');
      expect((await readNames(home))['agt_cursor']).toBeUndefined();
    });

    it('refuses a name with a newline in it rather than corrupting every column', async () => {
      const { seams } = withKept(snapshotWith([CLAUDE]));

      const { out } = await run(['agents', 'name', 'claude-code', 'a\nb'], seams);

      expect(out.notes.join('\n')).toContain('control character');
    });

    it('puts the detected name back when asked to clear one', async () => {
      const { seams } = withKept(snapshotWith([CLAUDE]));
      await run(['agents', 'name', 'claude-code', 'Backend Coder'], seams);

      const { out } = await run(['agents', 'name', 'claude-code', '--clear'], seams);

      expect(out.text).toContain('Claude Code');
      expect(await readNames(home)).toEqual({});
    });

    it('says what an agent is called when no new name is given', async () => {
      const { seams } = withKept(snapshotWith([CLAUDE]));

      const { out } = await run(['agents', 'name', 'claude-code'], seams);

      expect(out.text).toContain('is called "Claude Code"');
      expect(out.notes.join('\n')).toContain('detector');
    });
  });

  describe('discovering them', () => {
    it('asks what to call each one, and keeps the answer', async () => {
      const { seams } = hosting();
      const answers = new Map([
        ['Claude Code', 'Backend Coder'],
        ['Cursor', 'Frontend'],
      ]);

      await run(
        ['agents', 'discover', '--no-probe'],
        seams,
        async ({ shown }) => answers.get(shown) ?? null,
        true,
      );

      const names = await readNames(home);
      expect(names['agt_claude-code']).toBe('Backend Coder');
    });

    it('never asks when the answer is being piped somewhere', async () => {
      /* A prompt on a machine with no person at it is a scan that hangs until
         somebody kills it. */
      const { seams } = hosting();
      let asked = 0;

      await run(
        ['agents', 'discover', '--no-probe', '--json'],
        seams,
        async () => {
          asked += 1;
          return 'Never';
        },
        true,
      );

      expect(asked).toBe(0);
    });

    it('never asks when nobody is at the terminal', async () => {
      const { seams } = hosting();
      let asked = 0;

      await run(['agents', 'discover', '--no-probe'], seams, async () => {
        asked += 1;
        return 'Never';
      });

      expect(asked).toBe(0);
    });

    it('names one from a flag, for anything that is not a person', async () => {
      const { seams } = hosting();

      await run(
        ['agents', 'discover', '--no-probe', '--name', 'claude-code=Backend Coder'],
        seams,
      );

      expect((await readNames(home))['agt_claude-code']).toBe('Backend Coder');
    });

    it('says which --name it ignored rather than failing the scan', async () => {
      /* Naming is a convenience. A discovery that refused to finish over one
         would be a discovery people learn to run with a flag. */
      const { seams } = hosting();

      const { out } = await run(
        ['agents', 'discover', '--no-probe', '--name', 'nowhere=Backend'],
        seams,
      );

      expect(out.notes.join('\n')).toContain('no agent called "nowhere"');
    });

    it('names the next thing to do', async () => {
      const { seams } = hosting();

      const { out } = await run(['agents', 'discover', '--no-probe'], seams);

      expect(out.text).toContain('memnox agents onboard');
    });
  });

  describe('one agent in detail', () => {
    it('names where each surface was proved, not how many there are', async () => {
      /* A count says how much this agent reaches; the path says who granted it,
         which is the half somebody can act on. */
      const { seams } = withKept(
        snapshotWith([
          {
            ...CLAUDE,
            surfaces: [{ kind: 'mcp', detectedFrom: '/home/dev/.claude.json' }],
          },
        ]),
      );

      const { out } = await run(['agents', 'status', 'claude-code'], seams);

      expect(out.text).toContain('/home/dev/.claude.json');
    });

    it('keeps the id on screen, because that is what a ledger row says', async () => {
      const { seams } = withKept(snapshotWith([CLAUDE]));

      const { out } = await run(['agents', 'status', 'claude-code'], seams);

      expect(out.text).toContain('agt_claude-code');
    });

    it('says no such agent rather than showing an empty one', async () => {
      const { seams } = withKept(snapshotWith([CLAUDE]));

      const { out } = await run(['agents', 'status', 'nowhere'], seams);

      expect(out.text).toContain('No agent called "nowhere"');
    });

    it('answers null as data rather than throwing', async () => {
      const { seams } = withKept();

      const { out } = await run(['agents', 'status', 'nowhere', '--json'], seams);

      expect(JSON.parse(out.text)).toEqual({ agent: null });
    });
  });

  describe('putting one to work', () => {
    it('offers what could be onboarded when the verb is typed with no subject', async () => {
      const { seams } = withKept(snapshotWith([CLAUDE]));

      const { out } = await run(['agents', 'onboard'], seams);

      expect(out.text).toContain('Claude Code');
      expect(out.text).toContain('memnox agents onboard');
    });

    it('sends somebody to login rather than failing at the control plane', async () => {
      const { seams } = withKept(snapshotWith([CLAUDE]));

      const { out } = await run(['agents', 'onboard', 'claude-code'], seams);

      expect(out.text).toContain('Not logged in');
      expect(out.notes.join('\n')).toContain('memnox login');
    });
  });

  /**
   * The name an agent is known by in the workspace.
   *
   * Asked at onboard rather than only at discovery, because this is the moment it
   * stops being local: the control plane hashes the hostname and never stores it,
   * so whatever is chosen here is the only human thing on the fleet row.
   */
  describe('the name the workspace will use', () => {
    /* Enrolment waits on a person in a browser, so these drive the chooser
       rather than the whole command: what is under test is which name is
       settled on, not the device flow that `agent-onboard.test.ts` covers. */
    const account = {
      version: 1 as const,
      baseUrl: 'https://cloud.memnox.test',
      workspaceId: 'acme',
      machineId: 'mch_host',
      token: 'machine-token',
      privateKey: 'unused',
      enrolledAt: '2026-09-05T10:00:00.000Z',
    };

    const choose = async (
      options: { json?: boolean; name?: string },
      interactive: boolean,
      ask: NameAsker = async () => null,
    ) => {
      const context = new CliContext(new RecordedOutput());
      const chosen = await chooseCloudName(
        context,
        home,
        CLAUDE,
        await readNames(home),
        account,
        options,
        interactive,
        ask,
      );
      return { chosen, out: context.out as RecordedOutput };
    };

    it('asks, and what it is told becomes the name everywhere', async () => {
      const { chosen } = await choose({}, true, async () => 'Backend Coder');

      expect(chosen.name).toBe('Backend Coder');
      /* Written locally too. One name in two places is one of them going
         stale, and the one that goes stale is whichever nobody is looking at. */
      expect((await readNames(home))['agt_claude-code']).toBe('Backend Coder');
    });

    it('says which workspace is asking, because that is what the name is for', async () => {
      let asked = '';
      await choose({}, true, async ({ lines }) => {
        asked = lines.join('\n');
        return null;
      });

      expect(asked).toContain('acme');
    });

    it('keeps what the agent is already called when Enter is pressed', async () => {
      const { chosen } = await choose({}, true, async () => null);

      expect(chosen.name).toBe('Claude Code');
    });

    it('takes a name from a flag without asking, for a setup script', async () => {
      let asked = 0;

      const { chosen } = await choose({ name: 'Backend Coder' }, true, async () => {
        asked += 1;
        return 'Never';
      });

      expect(chosen.name).toBe('Backend Coder');
      expect(asked).toBe(0);
    });

    it('never asks when nobody is at the terminal', async () => {
      /* Onboarding already waits on a browser. A prompt in front of that on a
         machine with nobody at it is an onboard that hangs rather than runs. */
      let asked = 0;

      const { chosen } = await choose({}, false, async () => {
        asked += 1;
        return 'Never';
      });

      expect(asked).toBe(0);
      expect(chosen.name).toBe('Claude Code');
    });

    it('keeps the current name when the one given is refused, rather than asking again', async () => {
      /* A prompt loop in front of an enrolment is where somebody gives up on
         onboarding altogether. */
      const { chosen, out } = await choose({}, true, async () => 'a\nb');

      expect(chosen.name).toBe('Claude Code');
      expect(out.notes.join('\n')).toContain('control character');
    });
  });

  describe('collecting what an operator said', () => {
    it('says nobody can have said anything when this machine is not logged in', async () => {
      /* Not an error. A machine with no account reaches nothing at all, which is
         the state the front page promises and the one most machines are in. */
      const { seams } = withKept(snapshotWith([CLAUDE]));

      const { out } = await run(['agents', 'control'], seams);

      expect(out.text).toContain('Not logged in');
      expect(out.notes.join('\n')).toContain('memnox login');
    });
  });
});
