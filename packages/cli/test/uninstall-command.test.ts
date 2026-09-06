import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { installGitHooks, installInterceptors } from '@memnox/interceptors';
import { CliContext } from '../src/cli-context';
import { RecordedOutput } from '../src/cli-output';
import { plainStyle } from '../src/style';
import { registerUninstallCommand } from '../src/commands/uninstall.command';
import { existsSync } from 'node:fs';
import { pauseDirFor, pendingDirFor } from '@memnox/core';

async function machine(): Promise<{ home: string; repo: string }> {
  const home = await mkdtemp(join(tmpdir(), 'memnox-uninst-'));
  const repo = await mkdtemp(join(tmpdir(), 'memnox-repo-'));
  await mkdir(join(repo, '.git', 'hooks'), { recursive: true });
  return { home, repo };
}

async function run(
  args: string[],
  home: string,
  repo: string,
  unwrap?: () => Promise<number>,
): Promise<RecordedOutput> {
  const out = new RecordedOutput();
  const program = new Command();
  registerUninstallCommand(program, new CliContext(out, plainStyle), {
    home: () => home,
    dir: () => repo,
    ...(unwrap === undefined ? {} : { unwrap }),
  });
  await program.parseAsync(args, { from: 'user' });
  return out;
}

describe('memnox uninstall', () => {
  it('takes the interceptors and the hooks off, and says what it removed', async () => {
    const { home, repo } = await machine();
    await installInterceptors(home, '/x/memnox-intercept');
    await installGitHooks(repo);

    const out = await run(['uninstall'], home, repo);

    expect(out.text).toContain('interceptor(s)');
    expect(out.text).toContain('pre-push and pre-commit');
  });

  it('keeps the rules and history unless asked to purge, and says where they are', async () => {
    const { home, repo } = await machine();
    await installInterceptors(home, '/x/memnox-intercept');
    await writeFile(join(home, '.memnox', 'config.toml'), 'mode = "enforce"\n');

    const out = await run(['uninstall'], home, repo);

    expect(out.text).toContain('still in');
    expect(out.text).toContain('--purge');
    expect(await readdir(join(home, '.memnox'))).toContain('config.toml');
  });

  it('deletes everything on --purge, and says PATH is the one thing it cannot undo', async () => {
    const { home, repo } = await machine();
    await installInterceptors(home, '/x/memnox-intercept');

    const out = await run(['uninstall', '--purge'], home, repo);

    expect(out.text).toContain('Nothing of Memnox is left');
    expect(out.notes.join('\n')).toContain('PATH');
    await expect(readdir(join(home, '.memnox'))).rejects.toThrow();
  });

  it('unwraps the MCP servers when it can, and otherwise says how', async () => {
    const { home, repo } = await machine();
    const unwrap = vi.fn(async () => 2);

    expect((await run(['uninstall'], home, repo, unwrap)).text).toContain(
      'Restored 2 MCP server(s)',
    );
    expect((await run(['uninstall'], home, repo)).notes.join('\n')).toContain(
      'memnox mcp unwrap',
    );
  });

  it('is safe on a machine where nothing was ever installed', async () => {
    const { home, repo } = await machine();
    const out = await run(['uninstall'], home, repo);

    expect(out.text).toContain('No interceptors were installed.');
    expect(out.text).toContain('No Memnox git hooks');
  });
});

describe('what a fresh install must not inherit', () => {
  /* A pause or a held call left behind would silently stop the next install before
     it had done anything, and nothing about it would appear in `why`. */
  it('clears held and paused state, and says how much', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-uninstall-state-'));
    await mkdir(pauseDirFor(home), { recursive: true });
    await writeFile(join(pauseDirFor(home), 'ses_1.json'), '{}');
    await mkdir(pendingDirFor(home), { recursive: true });

    const out = await run(['uninstall'], home, home);
    expect(out.text).toContain('Cleared 2');
    expect(existsSync(pauseDirFor(home))).toBe(false);
  });

  it('says nothing about state a fresh machine never had', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-uninstall-fresh-'));
    const out = await run(['uninstall'], home, home);
    expect(out.text).not.toContain('Cleared');
  });
});

describe('what purge can honestly claim', () => {
  it('says nothing is left when nothing is', async () => {
    const { home, repo } = await machine();
    const out = await run(['uninstall', '--purge'], home, repo);
    expect(out.text).toContain('Nothing of Memnox is left');
  });

  /* The rule file lives in the repository and is very likely committed, so it is not
     ours to delete — but claiming nothing is left while it sits there is the kind of
     small untruth that makes somebody stop trusting the rest of the output. */
  it('names the rule file it did not delete, rather than claiming a clean machine', async () => {
    const { home, repo } = await machine();
    await writeFile(join(repo, 'memnox.policies.toml'), 'version = 1\n');

    const out = await run(['uninstall', '--purge'], home, repo);
    expect(out.text).not.toContain('Nothing of Memnox is left');
    expect(out.text).toContain('memnox.policies.toml');
    expect(out.text).toContain('probably committed');
  });
});
