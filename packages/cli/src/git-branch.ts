import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/** A repo nested deeply under $HOME still terminates; nothing legitimate is deeper. */
const MAX_PARENT_WALK = 40;
const GIT_DIR = '.git';
const HEAD_FILE = 'HEAD';
const REF_PREFIX = 'ref: ';
const BRANCH_PREFIX = 'refs/heads/';
const GITDIR_PREFIX = 'gitdir: ';

/**
 * The checked-out branch, read straight from .git/HEAD.
 *
 * Deliberately not `git rev-parse`: this runs inside an editor hook on every
 * tool call, and spawning a process there costs more than the rule it feeds.
 * Never throws — no repository, a detached HEAD, or an unreadable file all mean
 * "no branch", and a policy that matches on branches simply does not apply.
 */
export function readBranch(cwd: string | undefined): string | undefined {
  if (cwd === undefined || cwd.length === 0) return undefined;

  const gitDir = findGitDir(cwd);
  if (gitDir === undefined) return undefined;

  let head: string;
  try {
    head = readFileSync(join(gitDir, HEAD_FILE), 'utf8').trim();
  } catch {
    return undefined; // No HEAD to read — treated as "no branch", never an error.
  }
  if (!head.startsWith(REF_PREFIX)) return undefined; // Detached HEAD names a commit, not a branch.

  const ref = head.slice(REF_PREFIX.length).trim();
  return ref.startsWith(BRANCH_PREFIX) ? ref.slice(BRANCH_PREFIX.length) : ref;
}

/** Resolves .git whether it is the repository's own directory or a worktree pointer file. */
function findGitDir(startDir: string): string | undefined {
  let current = resolve(startDir);
  for (let depth = 0; depth < MAX_PARENT_WALK; depth += 1) {
    const candidate = join(current, GIT_DIR);
    const kind = kindOf(candidate);
    if (kind === 'dir') return candidate;
    if (kind === 'file') return readGitDirPointer(candidate, current);

    const parent = dirname(current);
    if (parent === current) return undefined; // Filesystem root.
    current = parent;
  }
  return undefined;
}

function kindOf(path: string): 'dir' | 'file' | null {
  try {
    const stats = statSync(path);
    return stats.isDirectory() ? 'dir' : 'file';
  } catch {
    return null; // Not there — keep walking up.
  }
}

/** A worktree or submodule has `.git` as a file holding "gitdir: <path>". */
function readGitDirPointer(file: string, baseDir: string): string | undefined {
  let contents: string;
  try {
    contents = readFileSync(file, 'utf8').trim();
  } catch {
    return undefined; // Unreadable pointer — no branch rather than a broken tool call.
  }
  if (!contents.startsWith(GITDIR_PREFIX)) return undefined;

  const target = contents.slice(GITDIR_PREFIX.length).trim();
  return isAbsolute(target) ? target : resolve(baseDir, target);
}
