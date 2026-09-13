import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliContext } from '../src/cli-context';
import { RecordedOutput } from '../src/cli-output';
import { plainStyle } from '../src/style';
import { registerProtectCommand } from '../src/commands/protect.command';

/**
 * Writing the document from the new rules alone meant protecting a second CLI silently
 * deleted the first one's rules and reported success. Somebody who ran `protect --for`
 * three times ended with one CLI covered and believed they had three.
 */
describe('memnox protect --for <cli>', () => {
  let project: string;
  let previous: string;
  let realHome: string | undefined;

  beforeEach(async () => {
    previous = process.cwd();
    project = await mkdtemp(join(tmpdir(), 'memnox-for-'));
    /* Writing a rule file registers it, and the registry lives in the home directory.
       Without this a test run leaves temp paths in the registry of whoever ran it. */
    realHome = process.env['HOME'];
    process.env['HOME'] = await mkdtemp(join(tmpdir(), 'memnox-home-'));
    process.chdir(project);
  });

  afterEach(() => {
    process.chdir(previous);
    if (realHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = realHome;
  });

  async function protect(cli: string): Promise<void> {
    const program = new Command();
    registerProtectCommand(program, new CliContext(new RecordedOutput(), plainStyle));
    await program.parseAsync(['protect', '--for', cli], { from: 'user' });
  }

  async function ruleNames(): Promise<string[]> {
    const text = await readFile(join(project, 'memnox.policies.toml'), 'utf8');
    return [...text.matchAll(/^name = "(.+)"$/gm)].map((match) => match[1] as string);
  }

  it('keeps the rules already in the file', async () => {
    await protect('gh');
    await protect('git');

    const names = await ruleNames();
    expect(names).toContain('gh-deny');
    expect(names).toContain('git-deny');
  });

  it('updates rather than duplicates when the same CLI is written twice', async () => {
    await protect('git');
    const once = await ruleNames();
    await protect('git');

    expect(await ruleNames()).toEqual(once);
  });
});
