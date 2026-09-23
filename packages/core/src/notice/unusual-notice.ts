/**
 * Noticing as the gate asks it: read what this agent and session have done, decide, and
 * learn what went ahead. The one part of noticing that touches a file, through its store.
 */
import type { ActionRequest } from '../domain/action-event';
import { DECISION_EFFECT } from '../constants/decision.constants';
import { CHAIN_LINK } from '../discovery/composition';
import { DAY_MS, daysToMs, minutesToMs } from '../domain/time';
import type { MemnoxEvent } from '../event/event';
import { isNoticeable, shapeOf, type ActionShape } from './action-shape';
import {
  AGENT_SESSION_PREFIX,
  CHAIN_WINDOW_MINUTES,
  DEFAULT_NOTICE_WARMUP_DAYS,
  MOST_ACQUIRED_PER_SESSION,
  MOST_SEEN_PER_AGENT,
  NOTICE_MODE,
  NOVELTY_HISTORY_DAYS,
  TAINT_WINDOW_MINUTES,
  type NoticeMode,
} from './notice.constants';
import {
  acquiredWithin,
  isNovel,
  lapsedTaint,
  remember,
  rememberAcquired,
  taintInForce,
  withoutTaint,
  withTaint,
  type SeenSet,
  type SessionSignals,
  type Taint,
} from './notice-state';
import type { NoticeStore } from './notice-store';
import { taintClearedRow, taintedRow } from './taint-row';
import { applyNotices, noticesFor, type NoticeFacts, type VerdictLike } from './unusual';

export interface NoticeSettings {
  mode: NoticeMode;
  warmupDays: number;
  historyDays: number;
  chainWindowMinutes: number;
  taintWindowMinutes: number;
}

export const DEFAULT_NOTICE_SETTINGS: NoticeSettings = {
  mode: NOTICE_MODE.OBSERVE,
  warmupDays: DEFAULT_NOTICE_WARMUP_DAYS,
  historyDays: NOVELTY_HISTORY_DAYS,
  chainWindowMinutes: CHAIN_WINDOW_MINUTES,
  taintWindowMinutes: TAINT_WINDOW_MINUTES,
};

/** What the gate asks of noticing: a second look at a verdict, and a person's yes. */
export interface NoticePort {
  consider<T extends VerdictLike>(request: ActionRequest, verdict: T): T;
  /** A person allowed what was asked; absent a request, everything asked in this process. */
  personAllowed(request?: ActionRequest): void;
}

export interface UnusualNoticeDeps {
  store: NoticeStore;
  agent: string;
  /** The session `memnox run` named; absent, the agent itself is the session. */
  sessionId?: string;
  settings: NoticeSettings;
  /** Shortened to `~` in a reason. */
  home?: string;
  now?: () => Date;
  /** Where a taint and its clearing are recorded. Best effort, like every row. */
  journal?: (event: MemnoxEvent) => void;
}

/** What was read to decide, carried to learning so nothing is read twice. */
interface Read {
  seen: SeenSet | null;
  signals: SessionSignals | null;
  now: string;
}

/** Recency is refreshed at most this often, so a familiar action writes nothing. */
const REFRESH_SEEN_AFTER_MS = DAY_MS;

/** Questions a long-lived proxy keeps waiting on, so refusals never pile up in memory. */
const MOST_ASKED_KEPT = 32;

export class UnusualNotice implements NoticePort {
  /** Asked about in this process and not yet answered, so a yes can be learned. */
  private readonly asked: { request: ActionRequest; shape: ActionShape }[] = [];

  constructor(private readonly deps: UnusualNoticeDeps) {}

  /** The key both the chain and the taint are filed under, the same in every seam. */
  get session(): string {
    return this.deps.sessionId ?? `${AGENT_SESSION_PREFIX}${this.deps.agent}`;
  }

  consider<T extends VerdictLike>(request: ActionRequest, verdict: T): T {
    if (this.deps.settings.mode === NOTICE_MODE.OFF) return verdict;
    const shape = shapeOf(request, this.deps.home);
    // The ordinary call reads no file at all, which is what keeps this off the hot path.
    if (!isNoticeable(shape) || verdict.effect === DECISION_EFFECT.DENY) return verdict;
    if (verdict.effect === DECISION_EFFECT.ASK) {
      this.awaitAnswer(request, shape);
      return verdict;
    }
    const read = this.read(shape);
    const notices = noticesFor(this.factsFor(request, shape, read));
    const result = applyNotices(verdict, {
      notices,
      mode: this.deps.settings.mode,
      action: request.action,
    });
    if (result.effect === DECISION_EFFECT.ALLOW) this.learn(shape, read);
    else this.awaitAnswer(request, shape);
    return result;
  }

  personAllowed(request?: ActionRequest): void {
    const answered = this.asked.filter(
      (each) =>
        request === undefined ||
        (each.request.action === request.action &&
          each.request.target === request.target),
    );
    for (const each of answered) {
      this.asked.splice(this.asked.indexOf(each), 1);
      this.learn(each.shape, { seen: null, signals: null, now: this.now() });
    }
  }

  /** Puts the session under suspicion for the window, and records that it did. */
  taint(source: string): Taint {
    const now = this.now();
    const until = new Date(
      Date.parse(now) + minutesToMs(this.deps.settings.taintWindowMinutes),
    ).toISOString();
    const taint: Taint = { source, at: now, until };
    const store = this.deps.store;
    store.writeSignals(this.session, withTaint(store.readSignals(this.session), taint));
    this.record(taintedRow({ ...this.rowIdentity(), taint, at: now }));
    return taint;
  }

  /** A person lifting the suspicion before its window ends. Null when there was none. */
  clearTaint(by: string): Taint | null {
    const store = this.deps.store;
    const signals = store.readSignals(this.session);
    const taint = signals.taint;
    if (taint === undefined) return null;
    store.writeSignals(this.session, withoutTaint(signals));
    this.record(taintClearedRow({ ...this.rowIdentity(), taint, at: this.now(), by }));
    return taint;
  }

  private awaitAnswer(request: ActionRequest, shape: ActionShape): void {
    this.asked.push({ request, shape });
    if (this.asked.length > MOST_ASKED_KEPT) this.asked.shift();
  }

  private read(shape: ActionShape): Read {
    const now = this.now();
    return {
      seen: shape.novelty === null ? null : this.deps.store.readSeen(this.deps.agent),
      signals: this.currentSignals(now),
      now,
    };
  }

  private factsFor(request: ActionRequest, shape: ActionShape, read: Read): NoticeFacts {
    const { settings } = this.deps;
    const { now, seen } = read;
    const signals = read.signals ?? { acquired: [] };
    const novel =
      seen !== null &&
      shape.novelty !== null &&
      isNovel(seen, shape.novelty.key, { now, windowMs: daysToMs(settings.historyDays) });
    return {
      agent: this.deps.agent,
      action: request.action,
      shape,
      fields: request.arguments ?? {},
      novel,
      // Asked only of what is novel, so a familiar action never reads the start file.
      warmingUp: novel && this.warmingUp(now),
      acquired: acquiredWithin(signals, {
        now,
        windowMs: minutesToMs(settings.chainWindowMinutes),
      }),
      taint: taintInForce(signals, now),
    };
  }

  private warmingUp(now: string): boolean {
    const started = this.deps.store.startedAt(now);
    return (
      Date.parse(now) - Date.parse(started) < daysToMs(this.deps.settings.warmupDays)
    );
  }

  /** The session's record, with a lapsed taint cleared and its lapse recorded once. */
  private currentSignals(now: string): SessionSignals {
    const store = this.deps.store;
    const signals = store.readSignals(this.session);
    const lapsed = lapsedTaint(signals, now);
    if (lapsed === null) return signals;
    const cleared = withoutTaint(signals);
    store.writeSignals(this.session, cleared);
    this.record(taintClearedRow({ ...this.rowIdentity(), taint: lapsed, at: now }));
    return cleared;
  }

  /** What went ahead is remembered: the novelty seen, and anything taken, for the chain. */
  private learn(shape: ActionShape, read: Read): void {
    const { store, agent } = this.deps;
    const novelty = shape.novelty;
    if (novelty !== null) {
      const seen = read.seen ?? store.readSeen(agent);
      const stale = isNovel(seen, novelty.key, {
        now: read.now,
        windowMs: REFRESH_SEEN_AFTER_MS,
      });
      if (stale)
        store.writeSeen(
          agent,
          remember(seen, novelty.key, read.now, MOST_SEEN_PER_AGENT),
        );
    }
    if (shape.link !== CHAIN_LINK.ACQUIRE) return;
    const signals = read.signals ?? store.readSignals(this.session);
    const acquired = { step: shape.step, at: read.now };
    store.writeSignals(
      this.session,
      rememberAcquired(signals, acquired, MOST_ACQUIRED_PER_SESSION),
    );
  }

  private rowIdentity(): { sessionId: string; agent: string } {
    return { sessionId: this.session, agent: this.deps.agent };
  }

  private record(event: MemnoxEvent): void {
    try {
      this.deps.journal?.(event);
    } catch {
      // A lost row never stops the action it is about.
    }
  }

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }
}
