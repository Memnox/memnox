/**
 * Where noticing keeps its two records: one small file per agent and one per session, read
 * synchronously because the gate answers synchronously. Every seam process reads the same.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { MEMNOX_HOME } from '../config/config';
import { shortDigest } from '../domain/digest';
import {
  NOTICE_DIR,
  NOTICE_SEEN_DIR,
  NOTICE_SESSIONS_DIR,
  NOTICE_STARTED_FILE,
} from './notice.constants';
import {
  emptySeen,
  emptySignals,
  type SeenSet,
  type SessionSignals,
} from './notice-state';

/** What the notice reads and writes, so a test hands it memory and counts the calls. */
export interface NoticeStore {
  readSeen(agent: string): SeenSet;
  writeSeen(agent: string, seen: SeenSet): void;
  readSignals(session: string): SessionSignals;
  writeSignals(session: string, signals: SessionSignals): void;
  /** When noticing first ran on this machine, written as `now` the first time it is asked. */
  startedAt(now: string): string;
}

const OWNER_ONLY = 0o600;
const OWNER_ONLY_DIR = 0o700;

// Counted per write, so two writes in one process never share a scratch file.
let writes = 0;

export class FileNoticeStore implements NoticeStore {
  private readonly root: string;

  constructor(home: string) {
    this.root = join(home, MEMNOX_HOME, NOTICE_DIR);
  }

  readSeen(agent: string): SeenSet {
    const found = readRecord<SeenSet>(this.seenPath(agent));
    return found !== null && typeof found.entries === 'object' ? found : emptySeen();
  }

  writeSeen(agent: string, seen: SeenSet): void {
    writeRecord(this.seenPath(agent), seen);
  }

  readSignals(session: string): SessionSignals {
    const found = readRecord<SessionSignals>(this.signalsPath(session));
    return found !== null && Array.isArray(found.acquired) ? found : emptySignals();
  }

  writeSignals(session: string, signals: SessionSignals): void {
    writeRecord(this.signalsPath(session), signals);
  }

  startedAt(now: string): string {
    const path = join(this.root, NOTICE_STARTED_FILE);
    const found = readRecord<{ startedAt?: unknown }>(path);
    if (found !== null && typeof found.startedAt === 'string') return found.startedAt;
    writeRecord(path, { startedAt: now });
    return now;
  }

  // Named by digest, so an agent or session name can never walk out of the directory.
  private seenPath(agent: string): string {
    return join(this.root, NOTICE_SEEN_DIR, `${shortDigest(agent)}.json`);
  }

  private signalsPath(session: string): string {
    return join(this.root, NOTICE_SESSIONS_DIR, `${shortDigest(session)}.json`);
  }
}

/** Null when missing or torn, which means nothing remembered rather than an error. */
function readRecord<T>(path: string): T | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    // Written only by this store, so an object here is its own shape; callers check fields.
    return typeof parsed === 'object' && parsed !== null ? (parsed as T) : null;
  } catch {
    return null;
  }
}

/** Whole or not at all, through a rename, and never allowed to stop the action. */
function writeRecord(path: string, record: unknown): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: OWNER_ONLY_DIR });
    writes += 1;
    const scratch = `${path}.${process.pid}.${writes}.tmp`;
    writeFileSync(scratch, JSON.stringify(record), { mode: OWNER_ONLY });
    renameSync(scratch, path);
  } catch {
    // A lost memory costs one extra question later, which is cheaper than a stopped command.
  }
}
