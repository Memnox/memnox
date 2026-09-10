import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitRegionReader, WHOLE_FILE } from '@memnox/core';

/**
 * What a write touches, read off the working tree at the moment of the write.
 *
 * This runs inside the interceptor on every write, so every failure has to be
 * the whole file: not a repository, a new file, a language git has no pattern
 * for, git missing, or a diff that ran long. Nothing has always meant the whole
 * file to a lease, so this can fail to narrow a claim and never lose a
 * collision.
 */

const run = promisify(execFile);

const FILE = 'invoice.ts';
const ORIGINAL = `export function formatInvoice(x: number): string {
  return String(x);
}

export function retryCharge(attempt: number): boolean {
  if (attempt > 3) return false;
  return true;
}
`;

describe('reading a write off the working tree', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'memnox-region-'));
    await run('git', ['init', '-q'], { cwd: root });
    await run('git', ['config', 'user.email', 'test@memnox.test'], { cwd: root });
    await run('git', ['config', 'user.name', 'test'], { cwd: root });
    await writeFile(join(root, FILE), ORIGINAL, 'utf8');
    await run('git', ['add', '-A'], { cwd: root });
    await run('git', ['commit', '-qm', 'base'], { cwd: root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('names the function an edit is inside, with no parser anywhere', async () => {
    await writeFile(
      join(root, FILE),
      ORIGINAL.replace('attempt > 3', 'attempt > 5'),
      'utf8',
    );

    const region = await new GitRegionReader(root).read(FILE);

    expect(region.symbols).toEqual(['retryCharge']);
    expect(region.lines).not.toEqual([]);
  });

  it('names the other function when the other one is edited', async () => {
    await writeFile(
      join(root, FILE),
      ORIGINAL.replace('return String(x);', 'return x.toFixed(2);'),
      'utf8',
    );

    const region = await new GitRegionReader(root).read(FILE);

    expect(region.symbols).toEqual(['formatInvoice']);
  });

  it('names both where a change spans two functions', async () => {
    await writeFile(
      join(root, FILE),
      ORIGINAL.replace('return String(x);', 'return x.toFixed(2);').replace(
        'attempt > 3',
        'attempt > 5',
      ),
      'utf8',
    );

    const region = await new GitRegionReader(root).read(FILE);

    expect(new Set(region.symbols)).toEqual(new Set(['formatInvoice', 'retryCharge']));
  });

  it('takes the whole file for a file with nothing committed yet', async () => {
    /* A new file diffs to nothing against HEAD, which is the honest answer:
       there is no previous version to work out what changed in. */
    await writeFile(join(root, 'brand-new.ts'), 'export const x = 1;\n', 'utf8');

    expect(await new GitRegionReader(root).read('brand-new.ts')).toEqual(WHOLE_FILE);
  });

  it('takes the whole file where nothing was changed at all', async () => {
    expect(await new GitRegionReader(root).read(FILE)).toEqual(WHOLE_FILE);
  });

  it('takes the whole file outside a repository', async () => {
    const loose = await mkdtemp(join(tmpdir(), 'memnox-loose-'));
    try {
      await writeFile(join(loose, FILE), ORIGINAL, 'utf8');
      expect(await new GitRegionReader(loose).read(FILE)).toEqual(WHOLE_FILE);
    } finally {
      await rm(loose, { recursive: true, force: true });
    }
  });

  it('takes the whole file rather than waiting when git runs long', async () => {
    /* The budget matters more than the answer: this sits on the write path and
       a slow subprocess must not be felt. */
    const slow = new GitRegionReader(root, 1, async () => null);

    expect(await slow.read(FILE)).toEqual(WHOLE_FILE);
  });

  it('takes the whole thing when asked about a directory', async () => {
    /* The regression that mattered. A lease is usually taken on the directory a
       write lands in, and a directory's diff spans several files. Narrowing it
       by symbol would be a loosening change: two sessions editing different
       files under it each name the functions in their own, the two sets never
       meet, and both proceed where both used to wait. */
    await writeFile(join(root, 'other.ts'), 'export function handle() {}\n', 'utf8');
    await run('git', ['add', '-A'], { cwd: root });
    await run('git', ['commit', '-qm', 'second file'], { cwd: root });
    await writeFile(
      join(root, FILE),
      ORIGINAL.replace('attempt > 3', 'attempt > 5'),
      'utf8',
    );
    await writeFile(
      join(root, 'other.ts'),
      'export function handle() { return 1; }\n',
      'utf8',
    );

    /* Asked about the repository root, whose diff covers both files. */
    expect(await new GitRegionReader(root).read('.')).toEqual(WHOLE_FILE);
  });

  it('takes the whole file when asked about nothing', async () => {
    expect(await new GitRegionReader(root).read('  ')).toEqual(WHOLE_FILE);
  });
});
