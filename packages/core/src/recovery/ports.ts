/**
 * The git this needs, and nothing more. Behind a port because every operation here is
 * destructive by nature, and a test that runs them for real is a test that eventually
 * runs them somewhere it should not.
 */
export interface GitPort {
  /** stdout, trimmed. Throws with stderr when git exits non-zero. */
  run(args: readonly string[], env?: Record<string, string>): Promise<string>;
  /** The top of the working tree, or null when this is not a repository. */
  root(): Promise<string | null>;
}

/**
 * The working tree, as files. A file the agent created is untracked, so `git rm` will not
 * touch it — removing it is an unlink, and it has to be one the domain can be tested
 * without.
 */
export interface WorktreePort {
  exists(path: string): Promise<boolean>;
  /** Removes a file, and any directory it leaves empty behind it. Never throws. */
  remove(path: string): Promise<void>;
}

export const REWIND_REFUSAL = {
  NOT_A_REPO: 'not-a-repo',
  /** Merge, rebase, cherry-pick, revert or bisect. Restoring under one loses the state. */
  MID_OPERATION: 'mid-operation',
  NO_MILESTONE: 'no-milestone',
  UNKNOWN_MILESTONE: 'unknown-milestone',
} as const;

export type RewindRefusal = (typeof REWIND_REFUSAL)[keyof typeof REWIND_REFUSAL];

export class RewindRefused extends Error {
  constructor(
    readonly refusal: RewindRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'RewindRefused';
  }
}
