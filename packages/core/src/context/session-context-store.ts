/**
 * Where a session's context record lives, one small file per session under the Memnox home,
 * and the sweep that lets old session files go, here and under noticing, on a schedule.
 */
import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { MEMNOX_HOME } from '../config/config';
import { shortDigest } from '../domain/digest';
import { daysToMs, HOUR_MS } from '../domain/time';
import { NOTICE_DIR, NOTICE_SESSIONS_DIR } from '../notice/notice.constants';
import { readJsonFile, writeJsonFile } from '../store/json-records';
import {
  CONTEXT_DIR,
  CONTEXT_PRUNED_FILE,
  CONTEXT_SESSIONS_DIR,
  MOST_PRUNED_PER_PASS,
  PRUNE_EVERY_HOURS,
  SESSION_FILE_DAYS,
} from './context.constants';
import { emptyContextState, type SessionContextState } from './session-context';

export class SessionContextStore {
  private readonly root: string;

  constructor(home: string) {
    this.root = join(home, MEMNOX_HOME, CONTEXT_DIR, CONTEXT_SESSIONS_DIR);
  }

  /** Nothing remembered when the file is missing or torn, which costs one repeat at most. */
  async read(session: string): Promise<SessionContextState> {
    const found = await readJsonFile<Partial<SessionContextState>>(this.pathFor(session));
    if (found === null || typeof found !== 'object') return emptyContextState();
    return {
      shown: typeof found.shown === 'object' && found.shown !== null ? found.shown : {},
      asks: Array.isArray(found.asks) ? found.asks : [],
    };
  }

  async write(session: string, state: SessionContextState): Promise<void> {
    try {
      await writeJsonFile(this.pathFor(session), state);
    } catch {
      // A lost record repeats one decision or asks one question again; neither stops work.
    }
  }

  // Named by digest, so a session name can never walk out of the directory.
  private pathFor(session: string): string {
    return join(this.root, `${shortDigest(session)}.json`);
  }
}

/**
 * Lets session files untouched for a week go, at most once a day and a bounded number per
 * pass. Returns how many went. Every window these serve is minutes, so a week is generous.
 */
export async function pruneSessionFiles(home: string, now: Date): Promise<number> {
  const base = join(home, MEMNOX_HOME);
  const mark = join(base, CONTEXT_DIR, CONTEXT_PRUNED_FILE);
  const last = await readJsonFile<{ at?: unknown }>(mark);
  const lastAt = last !== null && typeof last.at === 'string' ? Date.parse(last.at) : 0;
  if (now.getTime() - lastAt < PRUNE_EVERY_HOURS * HOUR_MS) return 0;
  await writeJsonFile(mark, { at: now.toISOString() }).catch(() => undefined);

  const cutoff = now.getTime() - daysToMs(SESSION_FILE_DAYS);
  let budget = MOST_PRUNED_PER_PASS;
  for (const dir of [
    join(base, NOTICE_DIR, NOTICE_SESSIONS_DIR),
    join(base, CONTEXT_DIR, CONTEXT_SESSIONS_DIR),
  ]) {
    budget -= await pruneOlder(dir, cutoff, budget);
  }
  return MOST_PRUNED_PER_PASS - budget;
}

/** Up to `most` files in one directory older than the cutoff, removed; a missing one is none. */
async function pruneOlder(dir: string, cutoff: number, most: number): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    // No directory yet is nothing to sweep.
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (removed >= most) break;
    try {
      const path = join(dir, name);
      if ((await stat(path)).mtimeMs >= cutoff) continue;
      await unlink(path);
      removed += 1;
    } catch {
      // Another process took it first, or it went mid sweep; either way it is gone.
    }
  }
  return removed;
}
