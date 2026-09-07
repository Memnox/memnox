import { watch, type FSWatcher } from 'node:fs';

/**
 * Wakes the watcher when an agent's configuration changes, instead of making somebody
 * wait out an interval to be told a server arrived. `node:fs` rather than a file-watching
 * dependency: the whole need here is "tell me something under this directory moved".
 */

/** Enough for an editor's write-rename dance to finish, short enough to feel immediate. */
const SETTLE_MS = 250;

/**
 * What this program writes itself, which is never a change to report.
 *
 * `~` is watched, and every cycle saves a snapshot under `~/.memnox` — so without this
 * the watcher wakes on its own write, rescans, writes again, and the interval stops
 * meaning anything. A loop that spins is a worse watcher than one that sleeps.
 */
const OURS = '.memnox';

interface ConfigWatch {
  /** Resolves when something changed, or when the wait ran out. */
  next(timeoutMs: number): Promise<boolean>;
  close(): void;
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
  seams: {
    watch?: typeof watch;
    setTimer?: typeof setTimeout;
    clearTimer?: typeof clearTimeout;
  } = {},
): ConfigWatch {
  const start = seams.watch ?? watch;
  const setTimer = seams.setTimer ?? setTimeout;
  const clearTimer = seams.clearTimer ?? clearTimeout;

  let pending = false;
  let wake: (() => void) | null = null;
  const watchers: FSWatcher[] = [];

  const touched = (_event: string, name?: string | Buffer | null): void => {
    if (isOurs(name)) return;
    pending = true;
    if (wake !== null) {
      const resume = wake;
      wake = null;
      resume();
    }
  };

  for (const path of paths) {
    try {
      watchers.push(start(path, { recursive: true }, touched));
    } catch {
      // A directory nobody has created yet is nothing to watch, and not a failure.
    }
  }

  return {
    async next(timeoutMs: number): Promise<boolean> {
      if (pending) {
        pending = false;
        // Let a burst of writes settle, so one save is one rescan and not five.
        await new Promise((resolve) => setTimer(resolve, SETTLE_MS));
        return true;
      }
      const changed = await new Promise<boolean>((resolve) => {
        const timer = setTimer(() => {
          wake = null;
          resolve(false);
        }, timeoutMs);
        wake = (): void => {
          clearTimer(timer);
          resolve(true);
        };
      });
      if (changed) {
        pending = false;
        await new Promise((resolve) => setTimer(resolve, SETTLE_MS));
      }
      return changed;
    },
    close(): void {
      for (const watcher of watchers) watcher.close();
    },
  };
}
