import {
  TAINT_SESSION_TTL_S,
  TAINT_UNREADABLE_REASON,
  TAINT_UNREADABLE_SOURCE_TYPE,
} from '../constants/taint.constants';
import { CLEAN_TAINT, mergeTaint, type TaintAssessment } from '../domain/taint';

/** Unreadable provenance is indistinguishable from injected provenance — assume the worst. */
export const UNREADABLE_TAINT: TaintAssessment = {
  tainted: true,
  sources: [
    { sourceType: TAINT_UNREADABLE_SOURCE_TYPE, reason: TAINT_UNREADABLE_REASON },
  ],
};

/** A session's accumulated provenance, plus whether the backing store answered at all. */
export interface SessionTaintState {
  taint: TaintAssessment;
  /** False when the store is unreachable — callers must fail closed, not assume clean. */
  available: boolean;
}

export const CLEAN_SESSION_TAINT: SessionTaintState = {
  taint: CLEAN_TAINT,
  available: true,
};

export const UNAVAILABLE_SESSION_TAINT: SessionTaintState = {
  taint: UNREADABLE_TAINT,
  available: false,
};

/** Taint attaches to the session, not to strings, so a rewrite cannot launder it. */
export interface SessionTaintStore {
  read(sessionId: string): Promise<SessionTaintState>;
  /** Monotonic merge-in; a clean assessment never clears an existing one. */
  merge(sessionId: string, taint: TaintAssessment): Promise<void>;
}

/** Zero-infrastructure default: correct semantics inside one process. */
export class InMemorySessionTaintStore implements SessionTaintStore {
  private readonly sessions = new Map<
    string,
    { taint: TaintAssessment; expiresAt: number }
  >();

  async read(sessionId: string): Promise<SessionTaintState> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return CLEAN_SESSION_TAINT;
    if (entry.expiresAt <= Date.now()) {
      this.sessions.delete(sessionId);
      return CLEAN_SESSION_TAINT;
    }
    return { taint: entry.taint, available: true };
  }

  async merge(sessionId: string, taint: TaintAssessment): Promise<void> {
    if (!taint.tainted) return;
    const current = await this.read(sessionId);
    this.sessions.set(sessionId, {
      taint: mergeTaint(current.taint, taint),
      expiresAt: Date.now() + TAINT_SESSION_TTL_S * 1_000,
    });
  }
}
