/**
 * What `memnox run` drew around one session before the agent started: the repository it
 * works in and whether that repository is untrusted. Written down, because the seams that
 * rule on its commands are other processes and have to read the same answer.
 */
import { join } from 'node:path';

import { MEMNOX_HOME } from '../config/config';
import { JsonRecordDir } from '../store/json-records';

const CONTAINMENT_DIR = 'containment';

export interface SessionContainment {
  sessionId: string;
  /** The agent the session runs, so its probation and its destinations are its own. */
  agent: string;
  /** The repository root the session started in; absent outside a checkout. */
  root?: string;
  /** Started with `--untrusted`, so outward and destructive actions ask. */
  untrusted: boolean;
  startedAt: string;
}

export class SessionContainments {
  private readonly records: JsonRecordDir<SessionContainment>;

  constructor(home: string) {
    this.records = new JsonRecordDir(join(home, MEMNOX_HOME, CONTAINMENT_DIR));
  }

  declare(record: SessionContainment): Promise<void> {
    return this.records.write(record.sessionId, record);
  }

  /** Null for a session `memnox run` did not start, which is every hooked one. */
  read(sessionId: string): Promise<SessionContainment | null> {
    return this.records.read(sessionId);
  }

  clear(sessionId: string): Promise<void> {
    return this.records.remove(sessionId);
  }
}
