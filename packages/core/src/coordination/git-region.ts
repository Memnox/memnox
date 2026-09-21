import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { ownProcessEnv } from './own-path';
import { WHOLE_FILE, filesIn, regionFrom, type WrittenRegion } from './written-region';

/**
 * What a session is about to write, read off the working tree with a bounded git call.
 * Every failure answers `WHOLE_FILE`, so this can fail to narrow a claim, never lose one.
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
  /** `root` is the repository, since a lease path is relative to it. */
  constructor(
    private readonly root: string,
    private readonly timeoutMs: number = REGION_TIMEOUT_MS,
    private readonly run: typeof runGit = runGit,
  ) {}

  async read(path: string): Promise<WrittenRegion> {
    if (path.trim() === '') return WHOLE_FILE;
    try {
      // `-U0` so context rows do not widen every claim; `HEAD` because the edit is unstaged.
      const diff = await this.run(
        ['diff', '-U0', '--no-color', 'HEAD', '--', path],
        this.root,
        this.timeoutMs,
      );
      if (diff === null || diff.length > MAX_DIFF_BYTES) return WHOLE_FILE;

      // Narrowing only ever happens within one file: a directory-wide diff claims the lot.
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
  return runGitAccepting(args, { cwd, timeoutMs, acceptsDiffExit: false });
}

interface GitRun {
  cwd: string;
  timeoutMs: number;
  /** `git diff --no-index` exits 1 when the sides differ, which is the answer wanted. */
  acceptsDiffExit: boolean;
}

function runGitAccepting(args: readonly string[], run: GitRun): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      [...args],
      {
        cwd: run.cwd,
        // The real git: a seam reading its own region must not meet its own interceptor.
        env: ownProcessEnv(),
        timeout: run.timeoutMs,
        maxBuffer: MAX_DIFF_BYTES,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error === null) return resolve(stdout);
        // The exit status is a number here; a spawn failure puts a string code instead.
        const status: unknown = (error as { code?: unknown }).code;
        const differs = run.acceptsDiffExit && status === 1 && error.killed !== true;
        resolve(differs ? stdout : null);
      },
    );
  });
}

/**
 * What an edit is about to touch, diffed before it is written, since `GitRegionReader`
 * sees only changes already made. Both sides keep the file's name, so git's context matches.
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
    const diff = await runGitAccepting(
      ['diff', '--no-index', '-U0', '--no-color', join('a', name), join('b', name)],
      { cwd: scratch, timeoutMs, acceptsDiffExit: true },
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
