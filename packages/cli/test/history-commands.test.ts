import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { SqliteEventStore, type MemnoxEvent } from '@memnox/core';
import { CliContext } from '../src/cli-context';
import { RecordedOutput } from '../src/cli-output';
import { plainStyle } from '../src/style';
import { registerWhyCommand } from '../src/commands/why.command';
import {
  registerPurgeCommand,
  registerTimelineCommand,
} from '../src/commands/timeline.command';
import { since } from '../src/duration';

const NOW = new Date('2026-09-05T12:00:00.000Z');

function event(over: Partial<MemnoxEvent> = {}): MemnoxEvent {
  return {
    id: 'evt_1',
    schemaVersion: 1,
    at: '2026-09-05T10:00:00.000Z',
    sessionId: 'ses_1',
    agent: 'claude-code',
    actorType: 'agent',
    surface: 'mcp',
    operation: 'github.merge_pull_request',
    class: 'write',
    effect: 'deny',
    mode: 'enforce',
    reason: 'production is frozen',
    ...over,
  };
}

async function machine(events: MemnoxEvent[]): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'memnox-hist-'));
  const store = SqliteEventStore.forHome(home);
  for (const each of events) await store.append(each);
  store.close();
  return home;
}

type Register = (p: Command, c: CliContext, h: () => string, n: () => Date) => void;

async function run(
  register: Register,
  args: string[],
  home: string,
): Promise<RecordedOutput> {
  const out = new RecordedOutput();
  const program = new Command();
  register(
    program,
    new CliContext(out, plainStyle),
    () => home,
    () => NOW,
  );
  await program.parseAsync(args, { from: 'user' });
  return out;
}

describe('memnox why', () => {
  it('explains the last thing that did not simply proceed', async () => {
    const home = await machine([
      event({ id: 'a', at: '2026-09-05T09:00:00.000Z', effect: 'allow' }),
      event({
        id: 'b',
        rule: { name: 'no-friday-merge', layer: 'project', file: 'p.yaml', line: 12 },
        alternative: { action: 'git.push', resource: 'a branch', note: 'open a PR' },
        policyHash: 'abc123',
      }),
    ]);
    const out = await run(registerWhyCommand as Register, ['why'], home);

    expect(out.text).toContain('DENY');
    expect(out.text).toContain('no-friday-merge');
    expect(out.text).toContain('p.yaml:12');
    expect(out.text).toContain('production is frozen');
    // A refusal that names no way forward is a dead end.
    expect(out.text).toContain('git.push a branch');
    expect(out.text).toContain('abc123');
  });

  it('reads the rule back rather than re-running today’s rules on yesterday’s action', async () => {
    const home = await machine([
      event({ rule: { name: 'as-it-was-then', layer: 'user', file: 'old.yaml' } }),
    ]);
    const out = await run(registerWhyCommand as Register, ['why'], home);
    expect(out.text).toContain('as-it-was-then');
    expect(out.text).toContain('user layer');
  });

  it('explains an allow when asked, since almost nothing does', async () => {
    const home = await machine([
      event({ id: 'a', effect: 'deny' }),
      event({
        id: 'b',
        at: '2026-09-05T11:00:00.000Z',
        effect: 'allow',
        reason: 'no rule matched',
      }),
    ]);
    const out = await run(registerWhyCommand as Register, ['why', '--allowed'], home);
    expect(out.text).toContain('ALLOW');
    expect(out.text).toContain('no rule matched');
  });

  it('shows digests and never the payload behind them', async () => {
    const home = await machine([event({ argsDigest: 'deadbeef', exitCode: 1 })]);
    const out = await run(registerWhyCommand as Register, ['why', '--evidence'], home);
    expect(out.text).toContain('deadbeef');
    expect(out.text).toContain('the payload never left');
  });

  it('says what to do when nothing has happened yet', async () => {
    const out = await run(registerWhyCommand as Register, ['why'], await machine([]));
    expect(out.text).toContain('mcp wrap');
  });

  it('names the mode when observe kept a verdict from being applied', async () => {
    const home = await machine([
      event({ effect: 'allow', shadowEffect: 'deny', mode: 'observe' }),
    ]);
    const out = await run(registerWhyCommand as Register, ['why', '--allowed'], home);
    expect(out.text).toContain('DENY in enforce');
  });
});

describe('memnox timeline', () => {
  const rows = [
    event({ id: 'a', at: '2026-09-05T09:00:00.000Z', effect: 'allow', operation: 'ls' }),
    event({ id: 'b', at: '2026-09-05T09:30:00.000Z', effect: 'deny' }),
    event({ id: 'c', at: '2026-09-05T10:00:00.000Z', sessionId: 'ses_2', effect: 'ask' }),
  ];

  it('groups by session and counts what it showed', async () => {
    const out = await run(
      registerTimelineCommand as Register,
      ['timeline'],
      await machine(rows),
    );
    expect(out.text).toContain('ses_1');
    expect(out.text).toContain('ses_2');
    expect(out.text).toContain('3 action(s) across 2 session(s)');
  });

  it('filters to what did not proceed', async () => {
    const out = await run(
      registerTimelineCommand as Register,
      ['timeline', '--only', 'blocked'],
      await machine(rows),
    );
    expect(out.text).toContain('2 action(s)');
    expect(out.text).not.toContain('ls');
  });

  it('refuses an --only nobody defined, naming the ones that exist', async () => {
    await expect(
      run(
        registerTimelineCommand as Register,
        ['timeline', '--only', 'perhaps'],
        await machine(rows),
      ),
    ).rejects.toThrow(/allow, ask, deny, blocked/);
  });

  it('exports one JSON object per line for a pipe', async () => {
    const out = await run(
      registerTimelineCommand as Register,
      ['timeline', '--export', 'jsonl'],
      await machine(rows),
    );
    expect(out.lines).toHaveLength(3);
    expect(JSON.parse(out.lines[0] as string).id).toBe('a');
  });

  it('says so plainly when nothing was recorded', async () => {
    const out = await run(
      registerTimelineCommand as Register,
      ['timeline'],
      await machine([]),
    );
    expect(out.text).toContain('Nothing recorded yet.');
  });
});

describe('--since', () => {
  it.each([
    ['30m', '2026-09-05T11:30:00.000Z'],
    ['2h', '2026-09-05T10:00:00.000Z'],
    ['7d', '2026-08-29T12:00:00.000Z'],
  ])('reads %s the way somebody types it', (raw, expected) => {
    expect(since(raw, NOW)).toBe(expected);
  });

  it('takes an ISO timestamp too', () => {
    expect(since('2026-01-01T00:00:00.000Z', NOW)).toBe('2026-01-01T00:00:00.000Z');
  });

  it('refuses a duration nobody could parse, and shows the shapes it takes', () => {
    expect(() => since('a while', NOW)).toThrow(/30m, 2h, 7d/);
  });
});

describe('memnox purge', () => {
  const old = event({ id: 'old', at: '2026-01-01T00:00:00.000Z' });
  const recent = event({ id: 'new', at: '2026-09-05T00:00:00.000Z' });

  it('drops what is past the configured retention and says how many', async () => {
    const out = await run(
      registerPurgeCommand as Register,
      ['purge'],
      await machine([old, recent]),
    );
    expect(out.text).toContain('1 event(s) older than 30 days dropped');
  });

  it('deletes nothing on a dry run', async () => {
    const home = await machine([old, recent]);
    const out = await run(registerPurgeCommand as Register, ['purge', '--dry-run'], home);

    expect(out.text).toContain('Nothing was deleted');
    const store = SqliteEventStore.forHome(home);
    expect(await store.count()).toBe(2);
    store.close();
  });

  it('refuses a retention that would silently mean "keep nothing"', async () => {
    await expect(
      run(
        registerPurgeCommand as Register,
        ['purge', '--days', '0'],
        await machine([old]),
      ),
    ).rejects.toThrow(/above zero/);
  });
});
