import { join } from 'node:path';

import { MEMNOX_HOME, readJsonFile, writeJsonFile } from '@memnox/core';

/** How far each kind of send has got, so a pass sends only what is new. */

const CURSOR_FILE = 'sync.json';

export interface Cursor {
  /** The `at` of the newest event known to have landed. */
  pushedThrough?: string;
  lastPushAt?: string;
  /** `takenAt` of the newest scan already sent, so one scan is sent once. */
  censusThrough?: string;
  /** This machine's decisions about its agents when that scan was sent, since they change apart from it. */
  censusDecided?: string;
  /** Apart from the census cursor, so a refused findings post is not hidden behind a sent census. */
  findingsThrough?: string;
  /** A digest rather than a time, so a skill edited twice inside one interval is seen twice. */
  skillsDigest?: string;
  /** The rules decided here already offered to the team, as a digest of their refs. */
  decisionsDigest?: string;
  /** The stops and starts of protection already reported, as a digest of their ids. */
  protectionDigest?: string;
}

function cursorPathFor(home: string): string {
  return join(home, MEMNOX_HOME, CURSOR_FILE);
}

/** Empty when nothing was sent yet, which is where every machine starts. */
export async function readCursor(home: string): Promise<Cursor> {
  return (await readJsonFile<Cursor>(cursorPathFor(home))) ?? {};
}

export async function mergeCursor(home: string, patch: Cursor): Promise<void> {
  await writeJsonFile(cursorPathFor(home), { ...(await readCursor(home)), ...patch });
}
