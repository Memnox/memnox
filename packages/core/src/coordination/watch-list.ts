import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MEMNOX_HOME } from '../config/config';

/**
 * The repositories agents on this machine work in, which the daemon watches.
 *
 * Built by use rather than by asking anybody: `setup` adds the one it runs in, and
 * every seam that finds a repository adds that one. So the watcher covers where the
 * work is happening, including for an agent with no hooks that shares a repository
 * with one that has them.
 *
 * Synchronous, because a hook adds to it on its way out and a short process may not
 * wait for anything, and bounded, because a list that only grows is a list that
 * eventually costs the daemon a watch per folder anybody ever opened.
 */

const WATCH_FILE = 'watched.json';

/** The most repositories one machine watches; the oldest fall off first. */
const MOST_WATCHED = 50;

function listPath(home: string): string {
  return join(home, MEMNOX_HOME, WATCH_FILE);
}

function read(home: string): string[] {
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
    const known = read(home);
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
  return read(home).filter((root) => existsSync(join(root, '.git')));
}
