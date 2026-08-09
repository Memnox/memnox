import { execFileSync } from 'node:child_process';

const ENV_DIFF_BASE = 'MEMNOX_DIFF_BASE';
const DEFAULT_DIFF_BASE = 'HEAD~1';
const DIFF_MAX_BUFFER = 16 * 1024 * 1024;

/** Git's empty tree. Diffing against it yields the whole tree as additions. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export const DIFF_BASE_HELP = `git ref to diff against (default: $${ENV_DIFF_BASE} or ${DEFAULT_DIFF_BASE})`;

export interface DiffSelection {
  base?: string;
  staged?: boolean;
}

export interface DiffResult {
  diff: string;
  /** What the diff was taken against, so the scan can say what it covered. */
  base: string;
}

/** Where `memnox ci` gets the changes it scans. Injected so tests supply a diff directly. */
export type DiffSource = (selection: DiffSelection) => DiffResult;

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: DIFF_MAX_BUFFER });
}

/** True when the ref names something git can actually diff against. */
function resolves(ref: string): boolean {
  try {
    git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return true;
  } catch {
    // rev-parse exits non-zero for an unknown ref; that is the answer, not a fault.
    return false;
  }
}

export const gitDiff: DiffSource = (selection) => {
  if (selection.staged) {
    return { diff: git(['diff', '--cached', '--unified=0']), base: 'the staged changes' };
  }

  const requested = selection.base ?? process.env[ENV_DIFF_BASE];
  if (requested !== undefined) {
    // An explicit ref that does not exist is a mistake worth naming, not
    // something to silently paper over with a different base.
    if (!resolves(requested)) {
      throw new Error(
        `Cannot diff against "${requested}" — no such commit in this repository.`,
      );
    }
    return { diff: git(['diff', requested, '--unified=0']), base: requested };
  }

  // A first commit and a depth=1 shallow clone both lack HEAD~1. Scanning the
  // whole tree is the safe reading for a secret gate: skipping the scan would
  // let a CI job pass green having checked nothing.
  if (!resolves(DEFAULT_DIFF_BASE)) {
    return {
      diff: git(['diff', EMPTY_TREE, '--unified=0']),
      base: 'the whole tree (no commit before HEAD — shallow clone or first commit)',
    };
  }
  return {
    diff: git(['diff', DEFAULT_DIFF_BASE, '--unified=0']),
    base: DEFAULT_DIFF_BASE,
  };
};
