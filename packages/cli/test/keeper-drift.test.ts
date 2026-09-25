import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACTOR_TYPE,
  DECISION_EFFECT,
  ENFORCEMENT_MODE,
  EVENT_SCHEMA_VERSION,
  EVENT_SURFACE,
  TOOL_CLASS,
  type MemnoxEvent,
} from '@memnox/core';
import { registerStatusCommand } from '../src/commands/status.command';
import { registerWatchCommand } from '../src/commands/watch.command';
import { withEvents } from '../src/event-store';
import { BoundaryKeeper, KEPT_CHANGE, type KeepSeams } from '../src/keeper/keep-boundary';
import {
  DRIFT_GROUP,
  driftNotices,
  MOST_NOTICES_PER_PASS,
  type DriftItem,
} from '../src/keeper/keep-drift';
import { readDormantHere } from '../src/keeper/keep-dormant';
import { watchOnce } from '../src/keeper/keep-watch';
import {
  FRESH_STATE,
  readKeeperState,
  writeKeeperState,
} from '../src/keeper/keeper-state';
import { keepBoundary } from '../src/keeper/kept';
import { installClaudeHook } from '../src/protect/claude-hook';
import type { EditHookTarget } from '../src/protect/agent-hooks';
import { runCommand } from './cli-harness';
import { fakeSeams, FakeMachine, HOME } from './machine-harness';

/**
 * The daemon kept hooks in place and said nothing about anything else: a server added on
 * Tuesday, a credential logged into, an agent that updated itself. Only a foreground
 * `memnox watch` saw drift, the ledger never heard of any config change, and an agent
 * nobody had used since spring still held the keys it was given.
 */

const NOW = new Date('2026-09-24T10:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1_000;

const CLAUDE_CONFIG = `${HOME}/.claude.json`;

function claudeWith(servers: Record<string, string>): string {
  return JSON.stringify({
    mcpServers: Object.fromEntries(
      Object.entries(servers).map(([name, arg]) => [
        name,
        { command: 'npx', args: [arg] },
      ]),
    ),
  });
}

async function keptHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'memnox-drift-'));
  await keepBoundary(home, []);
  return home;
}

async function configRows(home: string): Promise<MemnoxEvent[]> {
  return withEvents(home, (store) => store.query({ withConfig: true }));
}

function item(group: DriftItem['group'], name: string): DriftItem {
  return { group, name, summary: `${name} moved` };
}

describe('the daemon noticing capability drift', () => {
  /* Setup puts the session tools into every agent's config, so the first look after
     setup saw them as a server nobody had announced. */
  it('never announces the session tools setup put there itself', async () => {
    const home = await keptHome();
    const machine = FakeMachine.from({
      [CLAUDE_CONFIG]: claudeWith({ github: 'gh-mcp' }),
    });
    const scan = fakeSeams(machine);
    await watchOnce(home, NOW, scan);

    await machine.write(
      CLAUDE_CONFIG,
      claudeWith({ github: 'gh-mcp', 'memnox-session': 'memnox-session' }),
    );

    expect((await watchOnce(home, NOW, scan)).items).toEqual([]);
  });

  it('sets a baseline first, notices a new server once, and then has moved on', async () => {
    const home = await keptHome();
    const machine = FakeMachine.from({
      [CLAUDE_CONFIG]: claudeWith({ github: 'gh-mcp' }),
    });
    const scan = fakeSeams(machine);

    expect((await watchOnce(home, NOW, scan)).items).toEqual([]);

    await machine.write(
      CLAUDE_CONFIG,
      claudeWith({ github: 'gh-mcp', slack: 'slack-mcp' }),
    );
    const second = await watchOnce(home, NOW, scan);
    expect(second.items.map((each) => [each.group, each.name])).toContainEqual([
      DRIFT_GROUP.NEW_SERVER,
      'slack',
    ]);

    // The baseline advanced, so the same server is not news on the next pass.
    expect((await watchOnce(home, NOW, scan)).items).toEqual([]);
    expect(
      (await readKeeperState(home)).baseline.snapshot?.servers.map((s) => s.name),
    ).toEqual(['github', 'slack']);
  });

  it('writes each drift to the ledger as config, with the file and a before and after', async () => {
    const home = await keptHome();
    const machine = FakeMachine.from({ [CLAUDE_CONFIG]: claudeWith({}) });
    const scan = fakeSeams(machine);
    await watchOnce(home, NOW, scan);
    await machine.write(CLAUDE_CONFIG, claudeWith({ slack: 'slack-mcp' }));

    await watchOnce(home, NOW, scan);

    const rows = (await configRows(home)).filter(
      (row) => row.operation === 'config.drift.new-server',
    );
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.surface).toBe(EVENT_SURFACE.CONFIG);
    expect(row?.target).toBe(CLAUDE_CONFIG);
    expect(row?.reason).toContain('before: absent; after:');
    expect(row?.rule?.name).toBe('watch for capability drift');
    // A config change is not agent work, so nothing counting work ever sees it.
    expect(await withEvents(home, (store) => store.query({}))).toEqual([]);
  });

  it('never looks on a machine nobody set up', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-drift-'));
    const machine = FakeMachine.from({ [CLAUDE_CONFIG]: claudeWith({ github: 'gh' }) });

    expect(await watchOnce(home, NOW, fakeSeams(machine))).toEqual({
      items: [],
      dormant: [],
    });
    expect((await readKeeperState(home)).baseline.snapshot).toBeNull();
  });
});

describe('drift notices', () => {
  it('says one kind of change in one notice, however many of it arrived', () => {
    const notices = driftNotices([
      item(DRIFT_GROUP.NEW_SERVER, 'slack'),
      item(DRIFT_GROUP.NEW_SERVER, 'stripe'),
      item(DRIFT_GROUP.NEW_SERVER, 'linear'),
      item(DRIFT_GROUP.NEW_SERVER, 'notion'),
    ]);

    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('slack, stripe, linear and 1 more');
    expect(notices[0]).toContain('memnox scan --mcp slack');
  });

  it('never floods: past the limit the rest is one line pointing at the timeline', () => {
    const notices = driftNotices(
      Object.values(DRIFT_GROUP).map((group) => item(group, `${group}-thing`)),
    );

    expect(notices).toHaveLength(MOST_NOTICES_PER_PASS);
    expect(notices[MOST_NOTICES_PER_PASS - 1]).toContain('memnox timeline');
  });
});

describe('the keeper writing what it changed to the ledger', () => {
  const onlyClaude = (): KeepSeams => ({
    // Nothing on PATH decides this: whether memnox-session is installed is the machine's business.
    session: async () => ({ held: [], written: [], files: [] }),
    targets: [
      {
        name: 'Claude Code',
        file: join('.claude', 'settings.json'),
        agent: 'claude-code',
        install: installClaudeHook,
        remove: async () => false,
      } satisfies EditHookTarget,
    ],
    wrap: async () => ({ names: [] }),
    projects: () => [],
    scan: fakeSeams(FakeMachine.from({})),
  });

  function quietAfter(
    wakes: number,
  ): () => { next: () => Promise<boolean>; close: () => void } {
    let left = wakes;
    return () => ({
      next: async () => {
        if (left === 0) return new Promise<boolean>(() => undefined);
        left -= 1;
        return true;
      },
      close: () => undefined,
    });
  }

  it('records an adopted agent with the file it rewrote', async () => {
    const home = await keptHome();
    await mkdir(join(home, '.claude'));
    const noticed: string[] = [];
    const keeper = new BoundaryKeeper(home, {
      log: () => undefined,
      notify: (message) => noticed.push(message),
      seams: onlyClaude(),
      now: () => NOW,
      watcher: quietAfter(0),
    });

    keeper.start();
    await expect.poll(async () => (await configRows(home)).length).toBe(1);
    keeper.stop();

    const [row] = await configRows(home);
    expect(row?.operation).toBe(`config.${KEPT_CHANGE.ADOPTED}`);
    expect(row?.agent).toBe('Claude Code');
    expect(row?.target).toBe(join(home, '.claude', 'settings.json'));
    expect(row?.reason).toContain('before: never hooked');
    expect(row?.class).toBe(TOOL_CLASS.WRITE);
    expect(noticed).toHaveLength(1);
  });

  it('scans once for a burst of config writes', async () => {
    const home = await keptHome();
    const seams = onlyClaude();
    const scan = fakeSeams(FakeMachine.from({}));
    let looks = 0;
    let passes = 0;
    const keeper = new BoundaryKeeper(home, {
      log: () => undefined,
      notify: () => undefined,
      seams: {
        ...seams,
        wrap: async () => {
          passes += 1;
          return { names: [] };
        },
        scan: {
          ...scan,
          now: () => {
            looks += 1;
            return scan.now();
          },
        },
      },
      now: () => NOW,
      watcher: quietAfter(3),
    });

    keeper.start();
    await expect.poll(() => passes).toBe(4);
    keeper.stop();

    expect(looks).toBe(1);
  });
});

describe('dormant agents', () => {
  const MACHINE = {
    [CLAUDE_CONFIG]: claudeWith({}),
    [`${HOME}/.aws/credentials`]: '[default]\naws_access_key_id = AKIAEXAMPLE',
  };
  const monthsAgo = new Date(NOW.getTime() - 40 * DAY_MS).toISOString();

  async function quietHome(): Promise<string> {
    const home = await keptHome();
    await writeKeeperState(home, {
      ...FRESH_STATE,
      firstSeen: { 'agt_claude-code': monthsAgo },
    });
    return home;
  }

  function work(agent: string, at: Date): MemnoxEvent {
    return {
      id: `evt_${at.getTime()}`,
      schemaVersion: EVENT_SCHEMA_VERSION,
      at: at.toISOString(),
      sessionId: 'ses_1',
      agent,
      actorType: ACTOR_TYPE.AGENT,
      surface: EVENT_SURFACE.SHELL,
      operation: 'ls',
      class: TOOL_CLASS.READ,
      effect: DECISION_EFFECT.ALLOW,
      mode: ENFORCEMENT_MODE.OBSERVE,
      reason: 'allowed',
    };
  }

  it('mentions an idle agent with reach once, with the command that retires it', async () => {
    const home = await quietHome();
    const scan = fakeSeams(FakeMachine.from(MACHINE));

    const first = await watchOnce(home, NOW, scan);
    expect(first.dormant.map((agent) => agent.agentId)).toEqual(['agt_claude-code']);
    expect(first.dormant[0]?.reach.credentials).toBeGreaterThan(0);

    expect((await watchOnce(home, NOW, scan)).dormant).toEqual([]);
    expect((await readKeeperState(home)).dormantNoticed).toEqual(['agt_claude-code']);
  });

  it('forgets the mention once the agent works again, so a later silence is news', async () => {
    const home = await quietHome();
    const scan = fakeSeams(FakeMachine.from(MACHINE));
    await watchOnce(home, NOW, scan);

    await withEvents(home, (store) => store.append(work('claude-code', NOW)));

    expect((await watchOnce(home, NOW, scan)).dormant).toEqual([]);
    expect((await readKeeperState(home)).dormantNoticed).toEqual([]);
  });

  it('calls nothing dormant that has not been known for the whole window', async () => {
    const home = await keptHome();
    const scan = fakeSeams(FakeMachine.from(MACHINE));

    expect((await watchOnce(home, NOW, scan)).dormant).toEqual([]);
    expect(await readDormantHere(home, scan.snapshots, NOW)).toEqual([]);
  });

  it('is read back for a screen from the daemon last look', async () => {
    const home = await quietHome();
    const scan = fakeSeams(FakeMachine.from(MACHINE));
    await watchOnce(home, NOW, scan);

    const dormant = await readDormantHere(home, scan.snapshots, NOW);

    expect(dormant.map((agent) => agent.name)).toEqual(['Claude Code']);
  });

  it('gets a row in memnox status, and the offboard hint', async () => {
    const { out } = await runCommand(
      (program, context) =>
        registerStatusCommand(program, context, {
          home: () => '/nowhere',
          project: () => '/nowhere',
          read: async () => ({
            setUp: true,
            mode: ENFORCEMENT_MODE.ENFORCE,
            daemon: 'keeping',
            agents: 2,
            hooked: [],
            mcpServers: 0,
            mcpWrapped: 0,
            rules: 0,
            today: { actions: 0, asked: 0, denied: 0 },
            waiting: 0,
            paused: 0,
            workspace: null,
            dormant: [{ name: 'Cursor', reach: '2 credentials' }],
          }),
        }),
      ['status'],
    );

    expect(out.text).toContain('dormant');
    expect(out.text).toContain('Cursor (2 credentials)');
    expect(out.text).toContain('memnox agents offboard');
  });
});

describe('memnox watch, on the comparison it now shares with the daemon', () => {
  it('reports a server that arrived between two cycles, and only then', async () => {
    const machine = FakeMachine.from({ [CLAUDE_CONFIG]: claudeWith({ github: 'gh' }) });

    const { out } = await runCommand(
      (program, context) =>
        registerWatchCommand(program, context, {
          buildSeams: () => fakeSeams(machine),
          cwd: () => '/nowhere',
          waiter: () => ({
            wait: async () =>
              machine.write(CLAUDE_CONFIG, claudeWith({ github: 'gh', slack: 'slack' })),
            close: () => undefined,
          }),
        }),
      ['watch', '--cycles', '2', '--no-probe'],
    );

    expect(out.text).toContain('New MCP server: slack');
    expect(out.text).not.toContain('New MCP server: github');
  });
});
