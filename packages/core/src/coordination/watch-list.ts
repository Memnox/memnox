import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MEMNOX_HOME } from '../config/config';

/**
 * The repositories the daemon watches, added by every seam that finds one. Synchronous,
 * because a hook adds on its way out, and bounded, because every entry costs a watch.
 */

const WATCH_FILE = 'watched.json';

/** The most repositories one machine watches; the oldest fall off first. */
const MOST_WATCHED = 50;

function listPath(home: string): string {
  return join(home, MEMNOX_HOME, WATCH_FILE);
}

function readWatched(home: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(listPath(home), 'utf8'));
    return Array.isArray(parsed)
      ? parsed.filter((each): each is string => typeof each === 'string')
      : [];
  } catch {
    // Nothing watched yet, which is a machine where no seam has seen a repository.
    return [];
  }
}

/** Best effort: a repository not remembered is one watched from the next time it is seen. */
export function rememberRepository(home: string, root: string): void {
  try {
    const known = readWatched(home);
    if (known.includes(root)) return;
    const next = [...known, root].slice(-MOST_WATCHED);
    const dir = join(home, MEMNOX_HOME);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(listPath(home), JSON.stringify(next, null, 2), 'utf8');
  } catch {
    // Nothing to do about it on the way out of a hook.
  }
}

/** The repositories to watch, only those that are still there. */
export function watchedRepositories(home: string): string[] {
  return readWatched(home).filter((root) => existsSync(join(root, '.git')));
}
