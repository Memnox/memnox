import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { HOOK_BLIND_SPOTS } from '@memnox/tool-hook';
import { CliContext } from '../src/cli-context';
import { RecordedOutput } from '../src/cli-output';
import { registerHooksCommand } from '../src/commands/hooks.command';
import { HookInstaller } from '../src/hook-installer';
import { plainStyle } from '../src/style';

const COMMAND = '/usr/bin/node /opt/memnox/tool-hook/cli.js';

function harness(): { run: (args: string[]) => Promise<void>; out: RecordedOutput } {
  const out = new RecordedOutput();
  const context = new CliContext(out, undefined, plainStyle);
  const program = new Command();
  const home = mkdtempSync(join(tmpdir(), 'memnox-hooks-cmd-'));
  registerHooksCommand(program, context, new HookInstaller(home, COMMAND));
  return {
    out,
    run: async (args) => {
      await program.parseAsync(['node', 'memnox', ...args]);
    },
  };
}

describe('memnox hooks', () => {
  it('reads as an answer when nothing is installed, not as a broken page', async () => {
    const { run, out } = harness();
    await run(['hooks', 'status']);

    expect(out.text).toContain('not installed');
    expect(out.notes.join(' ')).toContain('memnox hooks install');
  });

  it('names what the seam sees and what it cannot, in the same breath', async () => {
    const { run, out } = harness();
    await run(['hooks', 'install']);

    expect(out.text).toContain('Installed the Memnox tool hook');
    expect(out.text).toContain('filesystem.read');
    expect(out.text).toContain('BLIND TO');
    for (const spot of HOOK_BLIND_SPOTS) expect(out.text).toContain(spot);
    // The timeout is a way through, so it is declared beside the blind spots.
    expect(out.text).toContain('ungoverned');
  });

  it('reports the second install as unchanged rather than as a fresh one', async () => {
    const { run, out } = harness();
    await run(['hooks', 'install']);
    await run(['hooks', 'install']);

    expect(out.lines.filter((line) => line.includes('already installed'))).toHaveLength(
      1,
    );
  });

  it('shows what is actually installed, read off the file', async () => {
    const { run, out } = harness();
    await run(['hooks', 'install']);
    await run(['hooks', 'status']);

    expect(out.text).toContain(COMMAND);
  });

  it('says plainly when there was nothing to remove', async () => {
    const { run, out } = harness();
    await run(['hooks', 'uninstall']);

    expect(out.text).toContain('No Memnox tool hook was installed');
  });
});
