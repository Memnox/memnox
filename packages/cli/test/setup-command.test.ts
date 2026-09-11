import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account } from '@memnox/core';
import { registerSetupCommand } from '../src/commands/setup.command';
import { readNames } from '../src/agents/names';
import { readRecord } from '../src/agents/onboarding';
import { runCommand } from './cli-harness';
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

/** The control plane's half: a code, then an approval already granted. */
const deviceFlow = (url: string): Response => {
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
  }

  async function run(driven: Driven = {}) {
    if (driven.connected !== false) {
      await mkdir(join(home, '.memnox'), { recursive: true });
      await writeFile(
        join(home, '.memnox', 'account.json'),
        JSON.stringify(account),
        'utf8',
      );
    }
    const seams = fakeSeams(FakeMachine.from(MACHINE), {
      snapshots: new MemorySnapshots(),
    });
    const connects: number[] = [];
    return {
      connects,
      ...(await runCommand(
        (program, context) =>
          registerSetupCommand(
            program,
            context,
            () => home,
            () => seams,
            async () => {
              connects.push(1);
              return {
                account,
                machineId: account.machineId,
                workspaceId: account.workspaceId,
                mode: 'observe',
              };
            },
            async ({ shown }) => driven.names?.[shown] ?? null,
            async () => driven.yes !== false,
            () => driven.interactive !== false,
          ),
        ['setup', '--no-probe', '--no-open'],
      )),
    };
  }

  it('logs the machine in as its first step when it is not connected', async () => {
    const { connects } = await run({ connected: false, yes: false });

    expect(connects).toHaveLength(1);
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

  it('changes nothing for an agent that was refused', async () => {
    const { out } = await run({ yes: false });

    expect(await readRecord(home, 'agt_claude-code')).toBeNull();
    expect(out.notes.join('\n')).toContain('nothing on this machine changed');
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
