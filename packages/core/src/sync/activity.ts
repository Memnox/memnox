import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MEMNOX_HOME } from '../config/config';

/**
 * A mark that an agent on this machine just did something the workspace should see.
 *
 * The ledger is sent on a heartbeat, a minute apart, which made every session a
 * minute behind by the time anybody could look at it. A hook that writes a row
 * touches this, and the daemon's loop, which already wakes every couple of seconds
 * to check for a held question, sends at once when it is newer than the last send.
 * A file rather than a socket message, because the daemon may not be running, and a
 * mark left for it is still there when it starts.
 */

const ACTIVITY_STAMP = 'activity.stamp';

function stampPath(home: string): string {
  return join(home, MEMNOX_HOME, ACTIVITY_STAMP);
}

/** Best effort: a mark that cannot be written is a row sent a minute later. */
export async function markActivity(home: string, at: Date = new Date()): Promise<void> {
  try {
    await mkdir(join(home, MEMNOX_HOME), { recursive: true });
    await writeFile(stampPath(home), at.toISOString(), 'utf8');
  } catch {
    // The heartbeat still carries it; only the hurry is lost.
  }
}

/** Whether something was marked after `since`, in milliseconds since the epoch. */
export async function activitySince(home: string, since: number): Promise<boolean> {
  try {
    return (await stat(stampPath(home))).mtimeMs > since;
  } catch {
    return false;
  }
}
