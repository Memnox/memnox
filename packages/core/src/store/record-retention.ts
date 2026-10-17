import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { MEMNOX_HOME } from '../config/config';
import { processAlive } from '../coordination/lease-store';
import { RunTerminals } from '../discovery/run-terminal';
import { GRANTS_DIR } from '../gate/session-grants';
import { PENDING_DIR, PendingApprovals, type PendingApproval } from '../gate/pending';
import { MISSION_DIR, type Mission } from '../session/mission';
import { PAUSE_DIR, type SessionPause } from '../session/pause';
import { POSTS_DIR, type SessionPost } from '../session/posts';
import { TASK_DIR, type SessionTask } from '../session/session-task';
import { TURNS_DIR, type SessionTurn } from '../session/session-turns';
import { idsIn, JSON_SUFFIX } from './json-dir';
import { readJsonFile } from './json-records';

/**
 * The small records beside the ledger, dropped by the same retention window, so a machine
 * that ran agents for a year does not carry a year of them. Nothing still in force goes: an
 * answerable question, a pause nobody lifted, an open mission.
 */

/** Where `memnox run --transcript` keeps what an agent printed, one file per session. */
export const TRANSCRIPTS_DIR = 'transcripts';
export const TRANSCRIPT_SUFFIX = '.log';

export interface RetentionInput {
  home: string;
  /** Records last touched before this are old enough to go. */
  cutoff: string;
  /** What is in force is judged against now, never against the cutoff. */
  now: string;
  dryRun?: boolean;
}

/** How many each kind dropped, or would drop, named by its directory. */
export type RecordsDropped = Record<string, number>;

interface Kept {
  dir: string;
  /** True when the record may go. */
  old: (record: unknown, input: RetentionInput) => boolean;
}

const RULES: readonly Kept[] = [
  // An expired question cannot be answered any more, whatever window is set.
  rule<PendingApproval>(PENDING_DIR, (each, input) => each.expiresAt <= input.now),
  rule<SessionPost>(POSTS_DIR, (each, input) => each.expiresAt <= input.now),
  rule<SessionPause>(
    PAUSE_DIR,
    (each, input) => each.resumedAt !== undefined && each.resumedAt < input.cutoff,
  ),
  rule<Mission>(
    MISSION_DIR,
    (each, input) => each.closedAt !== undefined && each.closedAt < input.cutoff,
  ),
  rule<SessionTurn>(
    TURNS_DIR,
    (each, input) => (each.endedAt ?? each.promptAt ?? '') < input.cutoff,
  ),
  rule<SessionTask>(TASK_DIR, (each, input) => each.declaredAt < input.cutoff),
];

function rule<T>(dir: string, old: (record: T, input: RetentionInput) => boolean): Kept {
  return {
    dir,
    // Each rule reads only its own directory, whose every file its own store wrote.
    old: (record, input) => old(record as T, input),
  };
}

export async function dropOldRecords(input: RetentionInput): Promise<RecordsDropped> {
  const dropped: RecordsDropped = {};
  for (const each of RULES) {
    dropped[each.dir] = await dropIn(each, input);
  }
  dropped[GRANTS_DIR] = await dropUntouched(GRANTS_DIR, input);
  dropped[TRANSCRIPTS_DIR] = await dropTranscripts(input);
  return dropped;
}

/**
 * Raw agent output, which `trace` has always said shares the ledger's retention and nothing
 * ever deleted. A session whose run is still alive keeps its transcript whatever its age,
 * since the file is still being written.
 */
async function dropTranscripts(input: RetentionInput): Promise<number> {
  const dir = join(input.home, MEMNOX_HOME, TRANSCRIPTS_DIR);
  const runs = new RunTerminals(input.home);
  let count = 0;
  for (const name of await readdir(dir).catch((): string[] => [])) {
    if (!name.endsWith(TRANSCRIPT_SUFFIX)) continue;
    const path = join(dir, name);
    const written = await stat(path).catch(() => null);
    if (written === null || written.mtime.toISOString() >= input.cutoff) continue;
    const run = await runs.read(name.slice(0, -TRANSCRIPT_SUFFIX.length));
    if (run !== null && processAlive(run.pid)) continue;
    count += 1;
    if (input.dryRun !== true) await rm(path, { force: true });
  }
  return count;
}

async function dropIn(kept: Kept, input: RetentionInput): Promise<number> {
  const dir = join(input.home, MEMNOX_HOME, kept.dir);
  let count = 0;
  for (const id of await idsIn(dir)) {
    const record = await readJsonFile<unknown>(join(dir, `${id}${JSON_SUFFIX}`));
    if (record === null || !kept.old(record, input)) continue;
    count += 1;
    if (input.dryRun === true) continue;
    // A pending question has a claim file beside it, which only its own store knows to remove.
    if (kept.dir === PENDING_DIR) await new PendingApprovals(input.home).clear(id);
    else await rm(join(dir, `${id}${JSON_SUFFIX}`), { force: true });
  }
  return count;
}

/** A session's grants carry no date of their own, so the file's last write stands for one. */
async function dropUntouched(name: string, input: RetentionInput): Promise<number> {
  const dir = join(input.home, MEMNOX_HOME, name);
  let count = 0;
  for (const id of await idsIn(dir)) {
    const path = join(dir, `${id}${JSON_SUFFIX}`);
    const written = await stat(path).catch(() => null);
    if (written === null || written.mtime.toISOString() >= input.cutoff) continue;
    count += 1;
    if (input.dryRun !== true) await rm(path, { force: true });
  }
  return count;
}
