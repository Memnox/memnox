import { watch, type FSWatcher } from 'node:fs';
import { MEMNOX_HOME } from '@memnox/core';

/**
 * Wakes the watcher when an agent's configuration changes, instead of making somebody
 * wait out an interval to be told a server arrived.
 */

/** Enough for an editor's write-rename dance to finish, short enough to feel immediate. */
const SETTLE_MS = 250;

/** What this program writes itself, or the watcher wakes on its own snapshot and spins. */
const OURS = MEMNOX_HOME;

interface ConfigWatch {
  /** Resolves when something changed, or when the wait ran out. */
  next(timeoutMs: number): Promise<boolean>;
  close(): void;
}

interface ConfigWatchSeams {
  watch?: typeof watch;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

/**
 * A path under our own directory, however the platform spelled it. A watcher that
 * reports no filename reports a change, because an unnamed one may be anybody's.
 */
function isOurs(name: string | Buffer | null | undefined): boolean {
  if (name === null || name === undefined) return false;
  const text = typeof name === 'string' ? name : name.toString('utf8');
  return text === OURS || text.startsWith(`${OURS}/`) || text.startsWith(`${OURS}\\`);
}

export function watchConfigPaths(
  paths: readonly string[],
  seams: ConfigWatchSeams = {},
): ConfigWatch {
  return new DirectoryWatch(paths, {
    watch: seams.watch ?? watch,
    setTimer: seams.setTimer ?? setTimeout,
    clearTimer: seams.clearTimer ?? clearTimeout,
  });
}

class DirectoryWatch implements ConfigWatch {
  private pending = false;
  private wake: (() => void) | null = null;
  private readonly watchers: FSWatcher[] = [];

  constructor(
    paths: readonly string[],
    private readonly seams: Required<ConfigWatchSeams>,
  ) {
    for (const path of paths) {
      try {
        this.watchers.push(
          seams.watch(path, { recursive: true }, (_event, name) => this.touched(name)),
        );
      } catch {
        // A directory nobody has created yet is nothing to watch, and not a failure.
      }
    }
  }

  async next(timeoutMs: number): Promise<boolean> {
    if (this.pending) {
      this.pending = false;
      // Let a burst of writes settle, so one save is one rescan and not five.
      await this.settle();
      return true;
    }
    const changed = await this.waitForChange(timeoutMs);
    if (changed) {
      this.pending = false;
      await this.settle();
    }
    return changed;
  }

  close(): void {
    for (const watcher of this.watchers) watcher.close();
  }

  private touched(name: string | Buffer | null | undefined): void {
    if (isOurs(name)) return;
    this.pending = true;
    if (this.wake !== null) {
      const resume = this.wake;
      this.wake = null;
      resume();
    }
  }

  private waitForChange(timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = this.seams.setTimer(() => {
        this.wake = null;
        resolve(false);
      }, timeoutMs);
      this.wake = (): void => {
        this.seams.clearTimer(timer);
        resolve(true);
      };
    });
  }

  private async settle(): Promise<void> {
    await new Promise((resolve) => this.seams.setTimer(resolve, SETTLE_MS));
  }
}
