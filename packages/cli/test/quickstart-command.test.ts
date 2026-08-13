import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { CliContext } from '../src/cli-context';
import { RecordedOutput } from '../src/cli-output';
import { registerQuickstartCommand } from '../src/commands/quickstart.command';

describe('memnox quickstart', () => {
  let workspace: string;
  let out: RecordedOutput;

  const run = async (args: string[]): Promise<void> => {
    const program = new Command();
    program.exitOverride();
    registerQuickstartCommand(program, new CliContext(out));
    await program.parseAsync(['node', 'memnox', 'quickstart', ...args]);
  };

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'memnox-quickstart-'));
    out = new RecordedOutput();
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('writes starter policies in one step', async () => {
    const file = join(workspace, 'policies.yaml');

    await run(['--file', file]);

    expect(await readFile(file, 'utf8')).toContain('production-database-protection');
  });

  it('steers the first run into monitor mode', async () => {
    await run(['--file', join(workspace, 'p.yaml')]);

    expect(out.text).toContain('--enforcement monitor');
  });

  it('says the offer plainly: local, no account, no limits', async () => {
    await run(['--file', join(workspace, 'p.yaml')]);

    expect(out.notes.join('\n')).toContain('no account');
  });

  // Rules someone already wrote are theirs; quickstart must not replace them.
  it('never overwrites an existing policy file', async () => {
    const file = join(workspace, 'policies.yaml');
    await writeFile(file, 'version: 1\npolicies: []\n', 'utf8');

    await run(['--file', file]);

    expect(await readFile(file, 'utf8')).toBe('version: 1\npolicies: []\n');
    expect(out.notes.join('\n')).toContain('Keeping the policy file');
  });
});
