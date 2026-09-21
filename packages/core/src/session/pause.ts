import { join } from 'node:path';
import { MEMNOX_HOME } from '../config/config';
import { JsonRecordDir } from '../store/json-records';
import type { BreakerSignal } from './breaker';

/**
 * A session held for a person, on disk because the daemon notices, every seam has to
 * stop, and why it stopped is asked after those processes are gone. Unlike a denial it
 * names the count that produced it and can be lifted.
 */
export const PAUSE_DIR = 'paused';

export interface SessionPause {
  sessionId: string;
  signal: BreakerSignal;
  reason: string;
  reached: number;
  ceiling: number;
  pausedAt: string;
  /** What was running when it tripped, so the report can name it. */
  lastAction?: string;
  resumedAt?: string;
  resumedBy?: string;
}

export function pauseDirFor(home: string): string {
  return join(home, MEMNOX_HOME, PAUSE_DIR);
}

export class SessionPauses {
  private readonly records: JsonRecordDir<SessionPause>;

  constructor(home: string) {
    this.records = new JsonRecordDir(pauseDirFor(home));
  }

  async pause(pause: SessionPause): Promise<void> {
    // First one wins, so a held session keeps the reason somebody may be reading.
    if ((await this.inForce(pause.sessionId)) !== null) return;
    await this.write(pause);
  }

  /** Null when never paused, which is the ordinary case. */
  read(sessionId: string): Promise<SessionPause | null> {
    return this.records.read(sessionId);
  }

  /** The pause that is actually holding this session, or null once it was lifted. */
  async inForce(sessionId: string): Promise<SessionPause | null> {
    const pause = await this.read(sessionId);
    if (pause === null || pause.resumedAt !== undefined) return null;
    return pause;
  }

  async all(): Promise<SessionPause[]> {
    const found = await this.records.all();
    return found.sort((a, b) => a.pausedAt.localeCompare(b.pausedAt));
  }

  /** Lifting stays in the record: who let it go on is the next postmortem question. */
  async resume(sessionId: string, by: string, at: string): Promise<SessionPause | null> {
    const pause = await this.inForce(sessionId);
    if (pause === null) return null;
    const resumed = { ...pause, resumedAt: at, resumedBy: by };
    await this.write(resumed);
    return resumed;
  }

  async clear(sessionId: string): Promise<void> {
    await this.records.remove(sessionId);
  }

  // Atomic, so a pause read while it is being lifted never reads as absent.
  private async write(pause: SessionPause): Promise<void> {
    await this.records.write(pause.sessionId, pause);
  }
}

/** What the agent is told. Written to be read by a model, and to carry no instruction. */
export function describePause(pause: SessionPause): string {
  return [
    `Memnox paused this session: ${pause.reason}.`,
    'Nothing further will run until a person looks at it.',
    `A person can lift it with: memnox resume ${pause.sessionId} --by <them>`,
  ].join(' ');
}
