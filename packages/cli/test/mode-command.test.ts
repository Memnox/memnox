import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { CliContext } from '../src/cli-context';
import { RecordedOutput } from '../src/cli-output';
import { plainStyle } from '../src/style';
import { registerModeCommand } from '../src/commands/mode.command';

async function run(home: string, args: string[]): Promise<RecordedOutput> {
  const out = new RecordedOutput();
  const program = new Command();
  registerModeCommand(program, new CliContext(out, plainStyle), () => home);
  await program.parseAsync(args, { from: 'user' });
  return out;
}

describe('memnox mode', () => {
  it('writes the mode as rules every seam loads, and takes them away again', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-mode-'));
    const file = join(home, '.memnox', 'mode.policies.toml');

    const on = await run(home, ['mode', 'investigate']);
    expect(on.text).toContain('investigate mode is on');
    expect(existsSync(file)).toBe(true);
    const registry = await readFile(join(home, '.memnox', 'policies.json'), 'utf8');
    expect(registry).toContain('mode.policies.toml');

    expect((await run(home, ['mode'])).text).toContain('investigate mode');

    await run(home, ['mode', 'off']);
    expect(existsSync(file)).toBe(false);
    expect(await readFile(join(home, '.memnox', 'policies.json'), 'utf8')).not.toContain(
      'mode.policies.toml',
    );
  });

  it('refuses a mode there is not', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-mode-'));
    await expect(run(home, ['mode', 'yolo'])).rejects.toThrow('not a mode');
  });
});
