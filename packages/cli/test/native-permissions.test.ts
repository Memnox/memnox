import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliContext } from '../src/cli-context';
import { RecordedOutput } from '../src/cli-output';
import { plainStyle } from '../src/style';
import { registerProtectCommand } from '../src/commands/protect.command';
import { runNative } from '../src/protect/native-permissions';

/**
 * These files belong to other programs and are edited by hand, so a `null`, an array or
 * a string where a list belongs used to throw a TypeError halfway through a write.
 */
const MALFORMED = [
  { name: 'null', claude: 'null', openclaw: 'null' },
  { name: 'an array', claude: '[]', openclaw: '[]' },
  {
    name: 'a string where a list belongs',
    claude: '{ "permissions": { "allow": "x" } }',
    openclaw: '{ "tools": { "allow": "x" } }',
  },
] as const;

describe('protect --apply-native and --revert-native on a malformed settings file', () => {
  let project: string;
  let home: string;
  let previous: string;
  let realHome: string | undefined;

  beforeEach(async () => {
    previous = process.cwd();
    project = await mkdtemp(join(tmpdir(), 'memnox-native-'));
    home = await mkdtemp(join(tmpdir(), 'memnox-native-home-'));
    // Writing a rule file registers it in the home directory, which must not be the real one.
    realHome = process.env['HOME'];
    process.env['HOME'] = home;
    process.chdir(project);
    const program = new Command();
    registerProtectCommand(program, new CliContext(new RecordedOutput(), plainStyle));
    await program.parseAsync(['protect', '--for', 'git'], { from: 'user' });
  });

  afterEach(() => {
    process.chdir(previous);
    if (realHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = realHome;
  });

  async function place(claude: string, openclaw: string): Promise<void> {
    await mkdir(join(home, '.claude'), { recursive: true });
    await mkdir(join(home, '.openclaw'), { recursive: true });
    await writeFile(join(home, '.claude', 'settings.json'), claude, 'utf8');
    await writeFile(join(home, '.openclaw', 'openclaw.json'), openclaw, 'utf8');
  }

  async function refusal(reverting: boolean): Promise<string | undefined> {
    const context = new CliContext(new RecordedOutput(), plainStyle);
    return runNative(context, reverting, () => home).then(
      () => undefined,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
  }

  for (const each of MALFORMED) {
    for (const reverting of [false, true]) {
      it(`refuses ${each.name} when ${reverting ? 'reverting' : 'applying'}`, async () => {
        await place(each.claude, each.openclaw);

        const refused = await refusal(reverting);

        expect(refused).toContain('nothing was changed');
        expect(refused).toContain(join(home, '.claude', 'settings.json'));
        expect(refused).toContain(join(home, '.openclaw', 'openclaw.json'));
        expect(await readFile(join(home, '.claude', 'settings.json'), 'utf8')).toBe(
          each.claude,
        );
        expect(await readFile(join(home, '.openclaw', 'openclaw.json'), 'utf8')).toBe(
          each.openclaw,
        );
        expect(await readdir(join(home, '.claude'))).toEqual(['settings.json']);
        expect(await readdir(join(home, '.openclaw'))).toEqual(['openclaw.json']);
      });
    }
  }

  it('still writes a well formed file beside a malformed one', async () => {
    await place('{ "permissions": { "allow": ["Read"] } }', 'null');

    expect(await refusal(false)).toBeUndefined();

    const written: unknown = JSON.parse(
      await readFile(join(home, '.claude', 'settings.json'), 'utf8'),
    );
    expect(written).toMatchObject({
      permissions: { allow: expect.arrayContaining(['Read']) },
    });
    expect(await readFile(join(home, '.openclaw', 'openclaw.json'), 'utf8')).toBe('null');
  });
});
