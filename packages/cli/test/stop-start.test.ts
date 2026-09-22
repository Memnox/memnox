import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DECISION_EFFECT,
  ENFORCEMENT_MODE,
  loadOrCreateConfig,
  protectionStopped,
  readProtectionStop,
  saveConfig,
  SqliteEventStore,
  writeAccount,
  type Account,
} from '@memnox/core';
import { HookAuthorizer, readMachineMode } from '@memnox/interceptors';
import { StoppedAuthorizer, UngovernedAuthorizer } from '@memnox/proxy';
import { CliContext } from '../src/cli-context';
import { RecordedOutput } from '../src/cli-output';
import { plainStyle } from '../src/style';
import { registerStartCommand, registerStopCommand } from '../src/commands/stop.command';
import { registerStatusCommand } from '../src/commands/status.command';
import { keepOnce } from '../src/keeper/keep-boundary';
import { keepBoundary } from '../src/keeper/kept';
import { describeResumed, endStopWhenDue } from '../src/protect/stop';
import { pushProtection } from '../src/sync/push';
import { readProtectionChanges } from '../src/sync/protection-changes';
import { CLOUD_EVENT } from '../src/sync/cloud-event';

/**
 * `memnox stop` turns protection off on purpose and on the record, and `memnox start`
 * brings back exactly the mode it left, as does the clock when a stop was given a time.
 */

const NOW = new Date('2026-09-24T10:00:00.000Z');
const LATER = new Date('2026-09-24T10:31:00.000Z');
const PERSON = 'ada';

const machine = (): Promise<string> => mkdtemp(join(tmpdir(), 'memnox-stop-'));

async function run(
  args: string[],
  home: string,
  at: Date = NOW,
): Promise<RecordedOutput> {
  const out = new RecordedOutput();
  const program = new Command();
  const context = new CliContext(out, plainStyle);
  const deps = { home: () => home, now: () => at, who: () => PERSON };
  registerStopCommand(program, context, deps);
  registerStartCommand(program, context, deps);
  await program.parseAsync(args, { from: 'user' });
  return out;
}

async function protectionRows(
  home: string,
): Promise<{ operation: string; actor: string }[]> {
  const store = SqliteEventStore.forHome(home);
  try {
    const rows = await store.query({ withConfig: true });
    return rows
      .filter((row) => row.operation.startsWith('protection.'))
      .map((row) => ({
        operation: row.operation,
        actor: row.principal ?? row.actorType,
      }));
  } finally {
    store.close();
  }
}

describe('memnox stop and memnox start', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stops every seam ruling and comes back in exactly the mode it left', async () => {
    const home = await machine();
    await saveConfig(home, { ...(await loadOrCreateConfig(home)), mode: 'enforce' });

    const out = await run(['stop', '--reason', 'debugging a hook'], home);

    expect(out.text).toContain('debugging a hook');
    expect(await protectionStopped(home, NOW)).toBe(true);
    // The tool hook reads off, while the mode somebody chose stays written as it was.
    expect(await readMachineMode(home)).toBe(ENFORCEMENT_MODE.OFF);
    expect((await loadOrCreateConfig(home)).mode).toBe(ENFORCEMENT_MODE.ENFORCE);

    const started = await run(['start'], home);

    expect(started.text).toContain('in enforce');
    expect(await protectionStopped(home, NOW)).toBe(false);
    expect(await readMachineMode(home)).toBe(ENFORCEMENT_MODE.ENFORCE);
  });

  it('writes who and why to the ledger, for the stop and the start', async () => {
    const home = await machine();
    await run(['stop', '--reason', 'flaky rule'], home);
    // A minute apart, so the ledger's chronological order is the order they happened in.
    await run(['start'], home, new Date('2026-09-24T10:01:00.000Z'));

    expect(await protectionRows(home)).toEqual([
      { operation: 'protection.stop', actor: PERSON },
      { operation: 'protection.start', actor: PERSON },
    ]);
  });

  it('comes back by itself when the time it was given runs out', async () => {
    const home = await machine();
    await run(['stop', '--for', '30m'], home);

    expect(await protectionStopped(home, new Date('2026-09-24T10:10:00.000Z'))).toBe(
      true,
    );
    // Seams read the expiry themselves, so nothing has to run for protection to return.
    expect(await protectionStopped(home, LATER)).toBe(false);

    const ended = await endStopWhenDue(home, LATER);

    expect(ended?.until).toBe('2026-09-24T10:30:00.000Z');
    expect(describeResumed(ended ?? fail())).toContain('back on');
    expect(await readProtectionStop(home)).toBeNull();
    expect((await protectionRows(home)).at(-1)).toEqual({
      operation: 'protection.start',
      actor: 'automation',
    });
  });

  it('says so when started after the clock already ended it', async () => {
    const home = await machine();
    await run(['stop', '--for', '30m'], home);

    const out = await run(['start'], home, LATER);

    expect(out.text).toContain('already protecting');
    expect((await protectionRows(home)).at(-1)?.actor).toBe('automation');
  });

  it('refuses a duration it cannot read before it stops anything', async () => {
    const home = await machine();
    await expect(run(['stop', '--for', 'a while'], home)).rejects.toThrow(/30m, 2h/);
    expect(await readProtectionStop(home)).toBeNull();
  });

  it('leaves the keeper inert while stopped, putting nothing back', async () => {
    const home = await machine();
    await keepBoundary(home, ['Claude Code']);
    const wrap = vi.fn(async () => ({ names: ['github'] }));
    await run(['stop'], home);

    expect(
      await keepOnce(home, { targets: [], wrap, projects: () => [], now: () => NOW }),
    ).toEqual([]);
    expect(wrap).not.toHaveBeenCalled();
  });

  it('lets every call through the hooks and the proxy while stopped', async () => {
    let stopped = true;
    const hook = new HookAuthorizer({ stopped: async () => stopped });
    const secret = {
      action: 'http.post',
      target: 'example.com',
      arguments: { key: 'AKIAABCDEFGHIJKLMNOP' },
    };

    expect((await hook.authorize(secret)).effect).toBe(DECISION_EFFECT.ALLOW);
    const proxy = new StoppedAuthorizer(new UngovernedAuthorizer(), async () => stopped);
    expect((await proxy.authorize({ name: 'x', arguments: {} })).reason).toContain(
      'stopped',
    );
    stopped = false;
    expect((await proxy.authorize({ name: 'x', arguments: {} })).reason).not.toContain(
      'stopped',
    );
  });

  it('reports the stop to the team from an enrolled machine, as a person acting', async () => {
    const home = await machine();
    await writeAccount(home, ACCOUNT);
    const posted: { events: { kind: string; actorType: string }[] }[] = [];
    vi.stubGlobal('fetch', (async (_url: string | URL, init?: RequestInit) => {
      posted.push(JSON.parse(String(init?.body ?? '{}')));
      return new Response(JSON.stringify({ accepted: 1, duplicates: 0 }), {
        status: 202,
      });
    }) as typeof fetch);

    const out = await run(['stop'], home);
    await pushProtection(home, ACCOUNT);

    expect(out.text).toContain('Your team sees this stop');
    expect(await readProtectionChanges(home)).toHaveLength(1);
    expect(posted[0]?.events[0]).toMatchObject({
      kind: CLOUD_EVENT.PROTECTION_STOPPED,
      actorType: 'human',
    });
    // Sent once: the next pass has nothing new to say.
    expect((await pushProtection(home, ACCOUNT)).outcome).toBe('nothing');
  });

  it('shows the stop first on memnox status', async () => {
    const out = new RecordedOutput();
    const program = new Command();
    registerStatusCommand(program, new CliContext(out, plainStyle), {
      read: async () => ({
        ...SET_UP,
        stopped: {
          at: NOW.toISOString(),
          by: PERSON,
          mode: 'enforce',
          reason: 'flaky rule',
        },
      }),
    });
    await program.parseAsync(['status'], { from: 'user' });

    expect(out.text).toContain(`stopped by ${PERSON}`);
    expect(out.text).toContain('flaky rule');
    expect(out.text).toContain('memnox start');
  });
});

function fail(): never {
  throw new Error('expected the stop to have ended');
}

const ACCOUNT: Account = {
  version: 1,
  baseUrl: 'https://cloud.test',
  workspaceId: 'acme',
  machineId: 'mch_1',
  token: 'machine-token',
  privateKey: generateKeyPairSync('ed25519')
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString(),
  enrolledAt: '2026-09-24T09:00:00.000Z',
};

const SET_UP = {
  setUp: true,
  mode: 'enforce',
  daemon: 'keeping' as const,
  agents: 1,
  hooked: ['Claude Code'],
  mcpServers: 0,
  mcpWrapped: 0,
  rules: 3,
  today: { actions: 0, asked: 0, denied: 0 },
  waiting: 0,
  paused: 0,
  workspace: null,
  dormant: [],
};
