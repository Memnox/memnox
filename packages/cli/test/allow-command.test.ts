import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { FileAllowances } from '@memnox/core';
import { CliContext } from '../src/cli-context';
import { RecordedOutput } from '../src/cli-output';
import { plainStyle } from '../src/style';
import { registerAllowCommand } from '../src/commands/allow.command';

async function run(home: string, args: string[]): Promise<RecordedOutput> {
  const out = new RecordedOutput();
  const program = new Command();
  registerAllowCommand(program, new CliContext(out, plainStyle), () => home);
  await program.parseAsync(args, { from: 'user' });
  return out;
}

describe('memnox allow', () => {
  it('allows a scope for a while, lists it, and ends it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-allow-cli-'));
    const out = await run(home, [
      'allow',
      'railway.*',
      '--env',
      'staging',
      '--for',
      '30m',
      '--reason',
      'reproducing the bug',
    ]);
    expect(out.text).toContain('railway.*');
    const [allowance] = await new FileAllowances(home).inForce(new Date().toISOString());
    expect(allowance?.environments).toEqual(['staging']);
    const minutes =
      (Date.parse(allowance!.until) - Date.parse(allowance!.since)) / 60_000;
    expect(minutes).toBe(30);

    expect((await run(home, ['allow', '--list'])).text).toContain(allowance!.id);
    await run(home, ['allow', '--revoke', allowance!.id]);
    expect(await new FileAllowances(home).inForce(new Date().toISOString())).toEqual([]);
  });
});
