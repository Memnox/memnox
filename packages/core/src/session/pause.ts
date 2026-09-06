import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MEMNOX_HOME } from '../config/config';
import type { BreakerSignal } from './breaker';

/**
 * A session held for a person.
 *
 * On disk rather than in memory, because the thing that noticed is a daemon and the
 * thing that has to stop is every seam in the session — and because "why did my agent
 * stop" is a question asked after the process that answered it has gone.
 *
 * A pause is not a denial and is deliberately shaped differently: it names the count
 * that produced it, it says how to lift it, and it can be lifted. A stop nobody can
 * argue with or undo is one people work around by uninstalling.
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
  constructor(private readonly home: string) {}

  async pause(pause: SessionPause): Promise<void> {
    /* First one wins: a session already held must not have its original reason
       overwritten by whatever tripped next while somebody was reading it. */
    if ((await this.inForce(pause.sessionId)) !== null) return;
    await mkdir(pauseDirFor(this.home), { recursive: true, mode: 0o700 });
    await this.write(pause);
  }

  async read(sessionId: string): Promise<SessionPause | null> {
    try {
      return JSON.parse(await readFile(this.pathFor(sessionId), 'utf8')) as SessionPause;
    } catch {
      // Never paused, which is the ordinary case.
      return null;
    }
  }

  /** The pause that is actually holding this session, or null once it was lifted. */
  async inForce(sessionId: string): Promise<SessionPause | null> {
    const pause = await this.read(sessionId);
    if (pause === null || pause.resumedAt !== undefined) return null;
    return pause;
  }

  async all(): Promise<SessionPause[]> {
    let names: string[];
    try {
      names = await readdir(pauseDirFor(this.home));
    } catch {
      return [];
    }
    const found: SessionPause[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const pause = await this.read(name.slice(0, -5));
      if (pause !== null) found.push(pause);
    }
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
    await rm(this.pathFor(sessionId), { force: true });
  }

  private pathFor(sessionId: string): string {
    return join(pauseDirFor(this.home), `${sessionId}.json`);
  }

  private async write(pause: SessionPause): Promise<void> {
    await mkdir(pauseDirFor(this.home), { recursive: true, mode: 0o700 });
    await writeFile(
      this.pathFor(pause.sessionId),
      `${JSON.stringify(pause, null, 2)}\n`,
      {
        encoding: 'utf8',
        mode: 0o600,
      },
    );
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
