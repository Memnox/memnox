import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runOsGuard } from '../src/protect/seam-install';
import { CliContext } from '../src/cli-context';
import { RecordedOutput } from '../src/cli-output';
import { plainStyle } from '../src/style';
import { readFile } from 'node:fs/promises';

/**
 * Seatbelt matches on the resolved path.
 *
 * A profile naming a symlinked one silently matches nothing: on macOS `/tmp` is
 * `/private/tmp`, so `(deny file-read* (subpath "/tmp/x/.ssh"))` let every read of
 * that key through while `memnox run` reported the sandbox was on. The same is true
 * of any home reached through a link, which is most managed machines.
 */
describe('the kernel profile names paths the kernel will match', () => {
  it('writes the resolved path beside the one it was given', async () => {
    const real = await mkdtemp(join(tmpdir(), 'memnox-guard-real-'));
    const home = join(real, 'home');
    await mkdir(join(home, '.memnox'), { recursive: true });

    const link = join(real, 'link');
    await symlink(home, link);

    const repo = await mkdtemp(join(tmpdir(), 'memnox-guard-repo-'));
    await writeFile(
      join(repo, 'memnox.policies.toml'),
      [
        'version = 1',
        '[[policies]]',
        'name = "no-keys"',
        '[policies.match]',
        'actions = [ "filesystem.read" ]',
        'targets = [ "**/.ssh", "**/.ssh/**" ]',
        '[policies.decision]',
        'effect = "deny"',
        'reason = "keys stay put"',
      ].join('\n'),
    );

    const out = new RecordedOutput();
    const previous = process.cwd();
    process.chdir(repo);
    try {
      await runOsGuard(new CliContext(out, plainStyle), repo, link);
    } finally {
      process.chdir(previous);
    }

    const written = out.lines.join('\n');
    if (!written.includes('seatbelt profile')) return; // Linux runs the Landlock path.

    const profile = await readFile(join(link, '.memnox', 'guard', 'memnox.sb'), 'utf8');
    expect(profile).toContain(link);
    // The half that actually bites.
    expect(profile).toContain(realpathSync(link));
  });
});
