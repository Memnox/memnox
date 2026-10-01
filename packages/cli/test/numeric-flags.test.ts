import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { readBudgets } from '@memnox/core';
import { CliContext } from '../src/cli-context';
import { RecordedOutput } from '../src/cli-output';
import { plainStyle } from '../src/style';
import { registerBudgetCommand } from '../src/commands/budget.command';
import { registerTaskCommand } from '../src/commands/task.command';
import {
  registerPurgeCommand,
  registerTimelineCommand,
} from '../src/commands/timeline.command';
import { positiveInteger } from '../src/positive-integer';

const NOW = new Date('2026-09-05T12:00:00.000Z');
const NOT_COUNTS = ['abc', '0', '-1', '1.5'];

type Register = (p: Command, c: CliContext, h: () => string, n: () => Date) => void;

async function run(register: Register, args: string[], home: string): Promise<void> {
  const program = new Command();
  register(
    program,
    new CliContext(new RecordedOutput(), plainStyle),
    () => home,
    () => NOW,
  );
  await program.parseAsync(args, { from: 'user' });
}

async function emptyHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'memnox-flags-'));
}

describe('positiveInteger', () => {
  it('reads a whole number above zero', () => {
    expect(positiveInteger('25', '--limit')).toBe(25);
  });

  it.each(NOT_COUNTS)('refuses %s and names the flag', (raw) => {
    expect(() => positiveInteger(raw, '--limit')).toThrow(
      '--limit takes a whole number above zero',
    );
  });
});

describe('every flag that takes a count', () => {
  it.each(NOT_COUNTS)(
    'timeline --limit %s is refused before SQLite sees it',
    async (raw) => {
      await expect(
        run(
          registerTimelineCommand as Register,
          ['timeline', '--limit', raw],
          await emptyHome(),
        ),
      ).rejects.toThrow('--limit takes a whole number above zero');
    },
  );

  it.each(NOT_COUNTS)('purge --days %s is refused', async (raw) => {
    await expect(
      run(registerPurgeCommand as Register, ['purge', '--days', raw], await emptyHome()),
    ).rejects.toThrow('--days takes a whole number above zero');
  });

  it.each(NOT_COUNTS)(
    'budget set --limit %s is refused and nothing is written',
    async (raw) => {
      const home = await emptyHome();
      await expect(
        run(
          registerBudgetCommand as Register,
          ['budget', 'set', 'deploys', '--actions', 'deploy.*', '--limit', raw],
          home,
        ),
      ).rejects.toThrow('--limit takes a whole number above zero');
      expect(await readBudgets(home)).toEqual([]);
    },
  );

  it('budget set refuses a dollar limit that is not a number', async () => {
    const home = await emptyHome();
    await expect(
      run(
        registerBudgetCommand as Register,
        ['budget', 'set', 'spend', '--actions', '*', '--unit', 'usd', '--limit', 'abc'],
        home,
      ),
    ).rejects.toThrow('must be a number');
    expect(await readBudgets(home)).toEqual([]);
  });

  it.each(NOT_COUNTS)('task set --hours %s is refused', async (raw) => {
    await expect(
      run(
        registerTaskCommand as Register,
        ['task', 'set', 'fix the build', '--hours', raw],
        await emptyHome(),
      ),
    ).rejects.toThrow('--hours takes a whole number above zero');
  });
});
