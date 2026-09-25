import { execFile } from 'node:child_process';
import { access, copyFile, rm, rmdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { ownProcessEnv } from '../coordination/own-path';
import type { GitPort, WorktreePort } from './ports';

/**
 * git and the working tree, as the ports the recovery domain defines. Everything here reads
 * or writes under `refs/memnox/`, except the restore `rewind` guards with a milestone.
 */
const run = promisify(execFile);

/** Big enough for a `for-each-ref` over a night of milestones. */
const MAX_OUTPUT = 8 * 1024 * 1024;

/**
 * git, run as a process. Nothing here shells out through a string: every argument is
 * passed as argv, so a branch called `; rm -rf /` is a branch name and not a command.
 */
export class NodeGit implements GitPort {
  constructor(private readonly cwd: string) {}

  async run(args: readonly string[], env: Record<string, string> = {}): Promise<string> {
    const { stdout } = await run('git', [...args], {
      cwd: this.cwd,
      // The real git: the one on PATH may be the interceptor, which would rule on us.
      env: { ...ownProcessEnv(), ...env },
      maxBuffer: MAX_OUTPUT,
    });
    return stdout.trim();
  }

  async root(): Promise<string | null> {
    try {
      return await this.run(['rev-parse', '--show-toplevel']);
    } catch {
      // Not a repository, which is an answer rather than a failure.
      return null;
    }
  }
}

export class NodeWorktree implements WorktreePort {
  constructor(private readonly root: string) {}

  async exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  async copy(from: string, to: string): Promise<boolean> {
    try {
      await copyFile(from, to);
      return true;
    } catch {
      // No index yet, as in a repository nothing was ever added to.
      return false;
    }
  }

  async size(path: string): Promise<number | null> {
    try {
      const found = await stat(path);
      return found.isFile() ? found.size : null;
    } catch {
      // Gone since it was listed, which is nothing to keep.
      return null;
    }
  }

  async remove(path: string): Promise<void> {
    await rm(path, { force: true, recursive: true });
    // A directory the agent created holds nothing once its files are gone.
    let parent = dirname(path);
    while (parent.startsWith(this.root) && parent !== this.root) {
      try {
        await rmdir(parent);
      } catch {
        // Not empty, or not ours to remove. Either way, stop climbing.
        return;
      }
      parent = dirname(parent);
    }
  }
}
