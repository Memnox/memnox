import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  digest,
  MEMNOX_HOME,
  MINUTE_MS,
  readJsonFile,
  writeJsonFile,
} from '@memnox/core';

/**
 * The small files an editor's hook leaves itself between runs, since each hook is its own
 * short process: a person's yes to take lines over, and when a session last did a chore.
 */

/** Enough of a digest to name a mark without naming the session or the file. */
const MARK_DIGEST_CHARS = 16;

/** How long a person's yes stays good for the edit it was asked about. */
const TAKEOVER_WINDOW_MS = 10 * MINUTE_MS;

const TAKEOVER_DIR = 'takeover';

function markPath(home: string, dir: string, key: string): string {
  return join(home, MEMNOX_HOME, dir, digest(key).slice(0, MARK_DIGEST_CHARS));
}

function takeoverPath(home: string, sessionId: string, file: string): string {
  return markPath(home, TAKEOVER_DIR, `${sessionId}\u0000${file}`);
}

/** Which lease the person was asked about, for when the edit they allowed lands. */
export async function writeTakeover(
  home: string,
  edit: { sessionId: string; file: string },
  leaseId: string,
): Promise<void> {
  try {
    await writeJsonFile(takeoverPath(home, edit.sessionId, edit.file), { leaseId });
  } catch {
    // Without the mark the edit still lands; the lines are simply not taken over.
  }
}

/**
 * The lease a person agreed to take over for this edit, used up by reading it, or null.
 */
export async function takeTakeover(
  home: string,
  edit: { sessionId: string; file: string },
  nowMs: number,
): Promise<string | null> {
  const mark = takeoverPath(home, edit.sessionId, edit.file);
  try {
    if (nowMs - (await stat(mark)).mtimeMs > TAKEOVER_WINDOW_MS) return null;
    const leaseId = (await readJsonFile<{ leaseId?: unknown }>(mark))?.leaseId;
    await rm(mark, { force: true });
    return typeof leaseId === 'string' ? leaseId : null;
  } catch {
    // Nobody was asked about this edit.
    return null;
  }
}

/** A chore a session does at most so often, such as renewing its holds. */
export interface Chore {
  name: string;
  sessionId: string;
  everyMs: number;
}

/**
 * Whether the chore is due again, marking it done when
 * it is. An unreadable mark only means asking again.
 */
export async function markIfDue(home: string, chore: Chore, now: Date): Promise<boolean> {
  const mark = markPath(home, chore.name, chore.sessionId);
  try {
    if (now.getTime() - (await stat(mark)).mtimeMs < chore.everyMs) return false;
  } catch {
    // Never marked, which is the first time this session asks.
  }
  try {
    await mkdir(dirname(mark), { recursive: true });
    await writeFile(mark, now.toISOString(), 'utf8');
  } catch {
    // Without the mark this simply asks again next time.
  }
  return true;
}
