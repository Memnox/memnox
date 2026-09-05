import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { stateLabelsOf } from '@memnox/core';
import { CliContext } from '../src/cli-context';
import { RecordedOutput } from '../src/cli-output';
import { plainStyle } from '../src/style';
import { minutesFrom, registerFreezeCommand } from '../src/commands/freeze.command';
import { readOverlays } from '@memnox/core';

const NOW = new Date('2026-09-05T10:00:00.000Z');
const home = (): Promise<string> => mkdtemp(join(tmpdir(), 'memnox-freeze-'));

async function run(args: string[], dir: string, at = NOW): Promise<RecordedOutput> {
  const out = new RecordedOutput();
  const program = new Command();
  registerFreezeCommand(
    program,
    new CliContext(out, plainStyle),
    () => dir,
    () => at,
  );
  await program.parseAsync(args, { from: 'user' });
  return out;
}

describe('memnox freeze', () => {
  it('reads the durations people type', () => {
    expect(minutesFrom('2h')).toBe(120);
    expect(minutesFrom('30m')).toBe(30);
    expect(minutesFrom('45')).toBe(45);
    expect(() => minutesFrom('a while')).toThrow(/30m, 2h/);
  });

  it('sets one, and says when it lifts itself', async () => {
    const dir = await home();
    const out = await run(
      ['freeze', 'payments', '--for', '2h', '--reason', 'INC-421'],
      dir,
    );

    expect(out.text).toContain('freeze:payments');
    expect(out.text).toContain('INC-421');
    // Ending on its own is the whole reason this is not a policy edit.
    expect(out.notes.join('\n')).toContain('lifts itself');
  });

  it('produces a label the engine already matches on', async () => {
    const dir = await home();
    await run(['freeze', 'payments', '--reason', 'x'], dir);

    const overlays = await readOverlays(dir);
    expect(stateLabelsOf(overlays, NOW.toISOString())).toEqual(['freeze:payments']);
  });

  it('lapses on its own, with nobody remembering to lift it', async () => {
    const dir = await home();
    await run(['freeze', 'payments', '--for', '30m', '--reason', 'x'], dir);

    const later = new Date('2026-09-05T11:00:00.000Z');
    expect(stateLabelsOf(await readOverlays(dir), later.toISOString())).toEqual([]);
    expect((await run(['freeze'], dir, later)).text).toContain('Nothing is frozen');
  });

  it('lists what is in force with the time left', async () => {
    const dir = await home();
    await run(['freeze', 'payments', '--for', '2h', '--reason', 'INC-421'], dir);
    expect((await run(['freeze'], dir)).text).toContain('2h left');
  });

  it('lifts one early, and keeps it in the record', async () => {
    const dir = await home();
    await run(['freeze', 'payments', '--reason', 'x'], dir);
    const out = await run(['freeze', '--lift'], dir);

    expect(out.text).toContain('Lifted freeze:payments');
    // Lifted, not deleted: what was frozen and when is part of the record.
    expect((await readOverlays(dir))[0]?.liftedAt).toBeDefined();
    expect(stateLabelsOf(await readOverlays(dir), NOW.toISOString())).toEqual([]);
  });

  it('says so plainly when nothing is frozen', async () => {
    expect((await run(['freeze'], await home())).text).toContain('Nothing is frozen');
    expect((await run(['freeze', '--lift'], await home())).text).toContain(
      'Nothing is frozen',
    );
  });
});
