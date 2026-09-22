import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { WHOLE_FILE, filesIn, regionFrom, type WrittenRegion } from './written-region';

/**
 * What a session is about to write, read off the working tree in real time.
 *
 * This runs inside the interceptor, on every write, before the agent's edit is
 * allowed through. `shared-leases.ts` states the budget next door: an
 * interceptor runs on every write and a slow control plane must not be felt.
 * The same applies to a subprocess, so this is bounded and abandoned rather
 * than waited on.
 *
 * **Every failure is the whole file.** Not a repository, a new file with no
 * diff, a language git has no context pattern for, git missing from the path,
 * or a diff that ran long: all of them answer `WHOLE_FILE`, and nothing has
 * always meant the whole file to a lease. This can fail to narrow a claim. It
 * cannot lose a collision.
 */

/** Long enough for one file in a large repository, short enough not to be felt. */
export const REGION_TIMEOUT_MS = 400;

/** A diff longer than this is a rewrite, and a rewrite is the whole file. */
const MAX_DIFF_BYTES = 512 * 1024;

export interface RegionReader {
  /** The region a write to this path touches, or `WHOLE_FILE` where unknown. */
  read(path: string): Promise<WrittenRegion>;
}

/** Knows nothing, so every lease is on the whole file. The default off git. */
export const NO_REGION: RegionReader = {
  read: async () => WHOLE_FILE,
};

export class GitRegionReader implements RegionReader {
  /**
   * `root` is the repository, because a lease path is repository-relative and
   * git has to be asked from somewhere it can resolve one.
   */
  constructor(
    private readonly root: string,
    private readonly timeoutMs: number = REGION_TIMEOUT_MS,
    private readonly run: typeof runGit = runGit,
  ) {}

  async read(path: string): Promise<WrittenRegion> {
    if (path.trim() === '') return WHOLE_FILE;
    try {
      /* `-U0` so a hunk covers only what changed: context lines would widen
         every claim by three rows in each direction and make neighbouring
         edits collide for no reason.

         `HEAD` rather than the index, because an agent's edit is in the
         working tree and has not been staged. A file with no committed version
         diffs to nothing, which is the new-file case falling back correctly. */
      const diff = await this.run(
        ['diff', '-U0', '--no-color', 'HEAD', '--', path],
        this.root,
        this.timeoutMs,
      );
      if (diff === null || diff.length > MAX_DIFF_BYTES) return WHOLE_FILE;

      /* Only where the diff is exactly the file that was asked about.
         A lease is usually taken on the *directory* a write lands in, and a
         directory's diff spans several files. Narrowing a directory claim by
         symbol would be a loosening change and not a refinement: two sessions
         editing different files under it each name the functions in their own,
         the two sets do not meet, and both proceed where both used to wait.
         The whole point of this is that it can only ever narrow within one
         file, so anything wider claims the lot. */
      const covered = filesIn(diff);
      if (covered.length !== 1 || covered[0] !== path) return WHOLE_FILE;
      return regionFrom(diff);
    } catch {
      // Not a repository, no git, or it ran long. All of them are the file.
      return WHOLE_FILE;
    }
  }
}

/** Null rather than a throw on anything git says it could not do. */
export async function runGit(
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      [...args],
      { cwd, timeout: timeoutMs, maxBuffer: MAX_DIFF_BYTES, windowsHide: true },
      (error, stdout) => {
        /* A non-zero exit is "not a repository" or "no such path", and both
           mean the same thing here: nothing is known about this write. */
        if (error !== null) return resolve(null);
        resolve(stdout);
      },
    );
  });
}

/**
 * What an edit is about to touch, before it is written.
 *
 * `GitRegionReader` reads the working tree, which only knows what a session has
 * already changed, and an editor's hook runs before the change lands. So a first
 * edit to a clean file claimed the whole file, and every edit after it claimed
 * the lines the previous one changed. This asks git the same question about the
 * file as it is now against the file as the edit will leave it, and reads the
 * same hunk headers: the lines and, where git can tell, the function.
 *
 * The two versions are written to a temporary directory under the file's own
 * name, so git picks the same context pattern it would for the real file. Every
 * failure is the whole file, exactly as it is next door.
 */
export async function upcomingRegion(
  fileName: string,
  before: string,
  after: string,
  timeoutMs: number = REGION_TIMEOUT_MS,
): Promise<WrittenRegion> {
  if (before === after) return WHOLE_FILE;
  if (before.length + after.length > MAX_DIFF_BYTES) return WHOLE_FILE;
  let scratch: string | undefined;
  try {
    scratch = await mkdtemp(join(tmpdir(), 'memnox-edit-'));
    const name = basename(fileName) === '' ? 'file' : basename(fileName);
    await mkdir(join(scratch, 'a'));
    await mkdir(join(scratch, 'b'));
    await writeFile(join(scratch, 'a', name), before, 'utf8');
    await writeFile(join(scratch, 'b', name), after, 'utf8');
    const diff = await runGitDiff(
      ['diff', '--no-index', '-U0', '--no-color', join('a', name), join('b', name)],
      scratch,
      timeoutMs,
    );
    if (diff === null) return WHOLE_FILE;
    const region = regionFrom(diff);
    return region.lines.length === 0 ? WHOLE_FILE : region;
  } catch {
    // No git, no temporary directory, or it ran long. All of them are the file.
    return WHOLE_FILE;
  } finally {
    if (scratch !== undefined) {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/**
 * `git diff --no-index` exits 1 when the two sides differ, which is the answer
 * wanted here rather than a failure. Anything else is nothing known.
 */
function runGitDiff(
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      [...args],
      { cwd, timeout: timeoutMs, maxBuffer: MAX_DIFF_BYTES, windowsHide: true },
      (error, stdout) => {
        if (error === null) return resolve(stdout);
        /* The exit status is on the error as a number; a spawn failure puts a
           string code there instead, and a timeout kills the child. */
        const status: unknown = (error as { code?: unknown }).code;
        resolve(status === 1 && error.killed !== true ? stdout : null);
      },
    );
  });
}
