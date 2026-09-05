import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { CliContext } from '../src/cli-context';
import { RecordedOutput } from '../src/cli-output';
import { plainStyle } from '../src/style';
import { registerConfigCommand } from '../src/commands/config.command';

async function run(args: string[], home: string): Promise<RecordedOutput> {
  const out = new RecordedOutput();
  const program = new Command();
  registerConfigCommand(program, new CliContext(out, plainStyle), () => home);
  await program.parseAsync(args, { from: 'user' });
  return out;
}

const home = (): Promise<string> => mkdtemp(join(tmpdir(), 'memnox-cfg-cmd-'));

describe('memnox config', () => {
  it('prints observe on a machine that has never been configured', async () => {
    const out = await run(['config', 'get', 'mode'], await home());
    expect(out.text.trim()).toBe('observe');
  });

  it('shows the change it made, so the terminal is the receipt', async () => {
    const dir = await home();
    const out = await run(['config', 'set', 'mode', 'enforce'], dir);
    expect(out.text).toContain('mode: observe → enforce');
    expect((await run(['config', 'get', 'mode'], dir)).text.trim()).toBe('enforce');
  });

  it('refuses a value that is not a mode, naming the ones that are', async () => {
    await expect(run(['config', 'set', 'mode', 'maybe'], await home())).rejects.toThrow(
      /observe/,
    );
  });

  it('refuses a setting that does not exist, and lists the ones that do', async () => {
    await expect(run(['config', 'get', 'colour'], await home())).rejects.toThrow(
      /retentionDays/,
    );
  });

  it('lists every setting', async () => {
    const out = await run(['config', 'list'], await home());
    for (const key of ['mode', 'retentionDays', 'failOpen', 'telemetry']) {
      expect(out.text).toContain(key);
    }
  });
});
