import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account } from '@memnox/core';
import { registerSetupCommand } from '../src/commands/setup.command';
import type { offboardAgent } from '../src/agents/onboard';
import { readNames } from '../src/agents/names';
import { readRecord, retireRecord } from '../src/agents/onboarding';
import { runCommand } from './cli-harness';
import { RecordedOutput } from '../src/cli-output';
import { FakeMachine, HOME, MemorySnapshots, fakeSeams } from './machine-harness';

/**
 * The whole first run, in one command.
 *
 * `login`, `discover`, `name` and `onboard` are four steps somebody meeting this
 * product has to know exist and know the order of. They do not, and there is no
 * reason they should, so this asks per agent: what it can reach, what to call
 * it, and whether to put it to work.
 */

const BASE = 'https://cloud.memnox.test';

const account: Account = {
  version: 1,
  baseUrl: BASE,
  workspaceId: 'acme',
  machineId: 'mch_host',
  token: 'machine-token',
  privateKey: 'unused',
  enrolledAt: '2026-09-05T10:00:00.000Z',
};

/** A machine with two agents and a credential one of them can reach. */
const MACHINE = {
  [`${HOME}/.claude.json`]: JSON.stringify({
    mcpServers: { github: { command: 'npx', args: ['github-mcp'] } },
  }),
  [`${HOME}/.cursor/mcp.json`]: JSON.stringify({ mcpServers: {} }),
  [`${HOME}/.aws/credentials`]: '[default]\naws_access_key_id = AKIAEXAMPLE',
};

/**
 * The control plane's half.
 *
 * The sponsored door first, because a run that is already connected enrols its
 * agents on this machine's own credential and never opens a browser. The device
 * flow behind it is what enrolling the machine itself still uses.
 */
const deviceFlow = (url: string): Response => {
  if (url.endsWith(`/machines/${account.machineId}/agents`)) {
    return json({
      id: 'mch_agent_1',
      token: 'mch_agent_secret',
      connection: 'mcp',
      mode: 'observe',
      mcpUrl: `${BASE}/v1/workspaces/acme/mcp`,
    });
  }
  if (url.endsWith('/v1/device/codes')) {
    return json({
      deviceCode: 'dev-1',
      userCode: 'ABCD-1234',
      intervalSeconds: 0,
      expiresAt: Date.now() + 60_000,
    });
  }
  if (url.endsWith('/v1/device/tokens')) {
    return json({
      machineId: 'mch_agent_1',
      token: 'mch_agent_secret',
      mode: 'observe',
      workspaceId: 'acme',
      mcpUrl: `${BASE}/v1/workspaces/acme/mcp`,
    });
  }
  return json({});
};

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('memnox setup', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'memnox-guided-'));
    /* The real config files, because onboarding rewrites them: the fake machine
       is what the scan reads, and this is what the rewrite touches. */
    await writeFile(
      join(home, '.claude.json'),
      JSON.stringify({ mcpServers: {} }, null, 2),
      'utf8',
    );
    await mkdir(join(home, '.cursor'), { recursive: true });
    await writeFile(
      join(home, '.cursor', 'mcp.json'),
      JSON.stringify({ mcpServers: {} }, null, 2),
      'utf8',
    );
    vi.stubGlobal('fetch', (async (url: URL | string) =>
      deviceFlow(String(url))) as typeof fetch);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(home, { recursive: true, force: true });
  });

  interface Driven {
    names?: Record<string, string>;
    yes?: boolean;
    connected?: boolean;
    interactive?: boolean;
    /** Whether the scan reached the control plane at the end of the run. */
    reported?: boolean;
    /** Where this run is pointed, which is the plane the account holds unless said. */
    url?: string;
    /** What the account on disk was enrolled against, for the move between planes. */
    enrolledAt?: string;
    /** The answer to the one question that is not about an agent: whether to move. */
    move?: boolean;
    /** A control plane that cannot be reached, for what a half-finished move says. */
    refuseConnect?: boolean;
    /** Held by the caller where the run throws, so what it said is still readable. */
    recorder?: RecordedOutput;
    /** What handing an agent back to the plane being left does, so no config is touched. */
    handBack?: (agentId: string) => {
      outcome: string;
      revoked?: boolean;
      because?: string;
    };
  }

  async function run(driven: Driven = {}) {
    if (driven.connected !== false) {
      await mkdir(join(home, '.memnox'), { recursive: true });
      await writeFile(
        join(home, '.memnox', 'account.json'),
        JSON.stringify({ ...account, baseUrl: driven.enrolledAt ?? BASE }),
        'utf8',
      );
    }
    const seams = fakeSeams(FakeMachine.from(MACHINE), {
      snapshots: new MemorySnapshots(),
    });
    const connects: string[] = [];
    const reports: string[] = [];
    const handedBack: string[] = [];
    return {
      connects,
      reports,
      handedBack,
      ...(await runCommand(
        (program, context) =>
          registerSetupCommand(
            program,
            context,
            () => home,
            () => seams,
            async (_context, _home, options) => {
              connects.push(options.url);
              if (driven.refuseConnect === true) {
                throw new Error(`Could not reach ${options.url}.`);
              }
              return {
                account: { ...account, baseUrl: options.url },
                machineId: account.machineId,
                workspaceId: account.workspaceId,
                mode: 'observe',
              };
            },
            async ({ shown }) => driven.names?.[shown] ?? null,
            /* Two questions with one seam: the fallback says which was asked,
               because only the move between planes defaults to no. */
            async (_question, fallback) =>
              fallback === false ? driven.move === true : driven.yes !== false,
            () => driven.interactive !== false,
            {},
            async (at: string) => {
              reports.push(at);
              return driven.reported !== false;
            },
            async (_home, _leaving, agentId) => {
              handedBack.push(agentId);
              const result = driven.handBack?.(agentId) ?? {
                outcome: 'done',
                revoked: true,
              };
              /* What the real one does, because the rest of the run turns on it:
                 an agent handed back is one the loop below offers again. */
              if (result.outcome === 'done') {
                await retireRecord(home, agentId, '2026-09-12T00:00:00.000Z');
              }
              return result as Awaited<ReturnType<typeof offboardAgent>>;
            },
          ),
        ['setup', '--no-probe', '--no-open', '--url', driven.url ?? BASE],
        driven.recorder,
      )),
    };
  }

  it('logs the machine in as its first step when it is not connected', async () => {
    const { connects } = await run({ connected: false, yes: false });

    expect(connects).toHaveLength(1);
  });

  describe('when the run is pointed somewhere else than the credential', () => {
    /* A machine enrolled against a control plane on localhost and then run
       against the real one used to print "Already connected" and carry on
       talking to localhost, `--url` included. Every screen after it named a
       workspace the person was not trying to reach. */
    const LOCAL = 'http://localhost:3000';

    it('says so rather than carrying on with the credential it has', async () => {
      const { out } = await run({ enrolledAt: LOCAL, url: BASE, yes: false });

      const text = out.notes.join('\n');
      expect(text).toContain('different control plane');
      expect(text).toContain(LOCAL);
      expect(text).toContain(BASE);
    });

    it('stays where it is when nobody says to move, and names the command that does', async () => {
      /* Enter must not take a laptop off the plane that governs it, so this one
         question defaults to no. */
      const { connects, out } = await run({ enrolledAt: LOCAL, url: BASE, yes: false });

      expect(connects).toHaveLength(0);
      expect(out.notes.join('\n')).toContain(`Staying on ${LOCAL}`);
    });

    it('enrols against the address it was pointed at once somebody says to move', async () => {
      const { connects } = await run({
        enrolledAt: LOCAL,
        url: BASE,
        move: true,
        yes: false,
      });

      expect(connects).toEqual([BASE]);
    });

    it('hands the agents back to the plane it is leaving before minting anything new', async () => {
      /* Revoking an agent takes the account that sponsored it, so a move that
         enrolled first would leave live credentials in the workspace somebody
         thought they had left. */
      await run({ enrolledAt: LOCAL, url: BASE, yes: true, names: {} });
      const { handedBack, connects, out } = await run({
        enrolledAt: LOCAL,
        url: BASE,
        move: true,
        yes: false,
      });

      expect(handedBack).toContain('agt_claude-code');
      expect(connects).toEqual([BASE]);
      expect(out.notes.join('\n')).toContain('credential is revoked');
    });

    it('names a credential the old plane would not take back rather than calling it done', async () => {
      await run({ enrolledAt: LOCAL, url: BASE, yes: true });
      const { out } = await run({
        enrolledAt: LOCAL,
        url: BASE,
        move: true,
        yes: false,
        handBack: () => ({ outcome: 'done', revoked: false }),
      });

      expect(out.notes.join('\n')).toContain('revoke');
    });

    it('offers the agents again after a move, because the new workspace has none of them', async () => {
      /* The records this machine wrote against the old plane are not proof the
         new one has these agents: the credential was minted there and its
         config pointed there. */
      await run({ enrolledAt: LOCAL, url: BASE, yes: true });
      const { out } = await run({ enrolledAt: LOCAL, url: BASE, move: true, yes: true });

      const text = out.notes.join('\n');
      expect(text).not.toContain('onboarded earlier');
      expect(text).toContain('2 agents are under Memnox');
    });

    it('says the agents are unmanaged when the new plane could not be reached', async () => {
      /* The half of a failed move somebody would otherwise find out tomorrow:
         the configs are back to their own and the credential on disk is still
         the old one, so nothing is governing what was handed back. */
      await run({ enrolledAt: LOCAL, url: BASE, yes: true });
      const recorder = new RecordedOutput();
      /* The error itself travels: the entry point prints it and exits non-zero,
         which is what a move that did not happen should do. What is under test
         is the rail beside it. */
      const said = await run({
        enrolledAt: LOCAL,
        url: BASE,
        move: true,
        refuseConnect: true,
        recorder,
      }).catch((err: unknown) => {
        expect(String(err)).toContain('Could not reach');
        return null;
      });

      const text = recorder.notes.join('\n');
      expect(said).toBeNull();
      expect(text).toContain('not under Memnox');
      expect(text).toContain('Run this again');
    });

    it('keeps the credential it has when there is nobody to ask', async () => {
      const { connects, out } = await run({
        enrolledAt: LOCAL,
        url: BASE,
        interactive: false,
      });

      expect(connects).toHaveLength(0);
      expect(out.notes.join('\n')).toContain('memnox login --url');
    });

    it('says an agent belongs to another workspace rather than reporting it done', async () => {
      /* The state `memnox login --url` leaves behind: the machine has moved and
         the agents have not. Onboarding over the old entry would back up a
         config already pointed at the other plane, which turns the undo into a
         second way to end up there. */
      await run({ enrolledAt: LOCAL, url: LOCAL, yes: true });
      const { out } = await run({ url: BASE, yes: false });

      const text = out.notes.join('\n');
      expect(text).toContain('elsewhere');
      expect(text).toContain('memnox agents offboard');
    });
  });

  it('does not enrol a second time on a machine that is already connected', async () => {
    /* A second credential for one laptop is a fleet row nobody added and a
       second thing somebody has to remember to revoke. */
    const { connects, out } = await run({ yes: false });

    expect(connects).toHaveLength(0);
    expect(out.notes.join('\n')).toContain('Already connected');
  });

  it('shows what each agent is and can reach before asking anything about it', async () => {
    /* Whether to onboard an agent that can read a cloud credential is a
       different decision from one that can only read this checkout, and the
       screen has to have said which before it asks. */
    const { out } = await run({ yes: false });

    const text = out.notes.join('\n');
    expect(text).toContain('can use');
    expect(text).toContain('.aws/credentials');
  });

  it('names the id, the config it would rewrite, and the servers already in it', async () => {
    /* The facts about the agent rather than a summary of them. The id is what a
       ledger row will say and the config path is the file that would change, so
       a person deciding has both in front of them. */
    const { out } = await run({ yes: false });

    const text = out.notes.join('\n');
    expect(text).toContain('agt_claude-code');
    expect(text).toContain('.claude.json');
    expect(text).toContain('github');
  });

  it('reads a yes typed at the name prompt as an answer to the next question', async () => {
    /* Nobody names an agent "y". Taking it would name one "y" and then never
       ask the question the person thought they were answering. */
    const { out } = await run({ names: { 'Claude Code': 'y' } });

    expect(out.notes.join('\n')).toContain('not a name');
    expect((await readNames(home))['agt_claude-code']).toBeUndefined();
  });

  it('lists every agent it offered, including the ones nothing happened to', async () => {
    /* A summary of only the successes lets an agent somebody answered a
       question about vanish, which is how a run ends with a person believing
       more is governed than is. */
    const { out } = await run({ yes: false });

    const text = out.notes.join('\n');
    expect(text).toContain('Claude Code');
    expect(text).toContain('Cursor');
    expect(text).toContain('you said no');
  });

  it('asks what each one should be called, and keeps the answer', async () => {
    await run({ names: { 'Claude Code': 'Backend Coder' }, yes: false });

    expect((await readNames(home))['agt_claude-code']).toBe('Backend Coder');
  });

  it('says which workspace the name is for, because that is what it is for', async () => {
    const { out } = await run({ yes: false });

    expect(out.notes.join('\n')).toContain('acme');
  });

  it('onboards the ones that were agreed to, under the name that was given', async () => {
    await run({ names: { 'Claude Code': 'Backend Coder' } });

    const record = await readRecord(home, 'agt_claude-code');
    expect(record).not.toBeNull();
    expect(record?.product).toBe('Claude Code');
  });

  it('reports the scan, so the agents it onboarded reach the console', async () => {
    /* Onboarding writes credentials and nothing was telling the workspace what
       these agents are. The Agents page reads a census, so a run that never
       sent one ended by saying five agents were under Memnox on a page that
       said there were none. */
    const { reports } = await run({});

    expect(reports).toHaveLength(1);
  });

  it('says the page will fill later when the scan could not be sent', async () => {
    /* Named rather than left for somebody to discover: an empty Agents page
       after a run that said five agents are governed reads as a broken
       product rather than as a network that was down. */
    const { out } = await run({ reported: false });

    expect(out.notes.join('\n')).toContain('next sync');
  });

  it('changes nothing for an agent that was refused', async () => {
    const { out } = await run({ yes: false });

    expect(await readRecord(home, 'agt_claude-code')).toBeNull();
    expect(out.notes.join('\n')).toContain('nothing on this machine changed');
  });

  it('opens no browser for an agent once the machine itself is connected', async () => {
    /* One approval per laptop. Asking again per agent is the same decision put
       five times, and a run that opens five tabs ends half finished. */
    const { out } = await run({});

    const text = out.notes.join('\n');
    expect(text).not.toContain('device?code');
    expect(text).toContain('no browser');
  });

  it('draws every line on one rail, including what enrolment says', async () => {
    /* Enrolment used to print its own block to stdout while the rest of the run
       drew a rail on stderr, so the one step that can block on a person looked
       like a different command had interrupted this one. */
    const { out } = await run({});

    expect(out.lines).toEqual([]);
  });

  it('says plainly that authority did not change', async () => {
    /* This is the moment somebody wonders whether agreeing has handed the agent
       more reach than it had. */
    const { out } = await run({});

    expect(out.notes.join('\n')).toContain('Authority is unchanged');
  });

  it('leaves an agent that is already onboarded alone rather than asking twice', async () => {
    await run({});

    const { out } = await run({});

    expect(out.notes.join('\n')).toContain('onboarded earlier');
  });

  it('stops rather than hanging when nothing is attached to the terminal', async () => {
    /* Every question below waits on a person. Asking with nothing on stdin is a
       command that hangs, which is worse than one that declines to run. */
    const { out } = await run({ interactive: false });

    const text = out.notes.join('\n');
    expect(text).toContain('nobody can be asked');
    expect(text).toContain('memnox agents onboard');
    expect(await readRecord(home, 'agt_claude-code')).toBeNull();
  });
});
