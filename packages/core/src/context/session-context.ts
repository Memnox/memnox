/**
 * What one agent session has been told and asked, kept between hook processes: the
 * decisions it was shown, so none is said twice, and the questions a person has yet to
 * answer, so a tool that then runs is read as their yes. Pure and bounded.
 */
import { minutesToMs } from '../domain/time';
import {
  ASK_ANSWER_MINUTES,
  MOST_PENDING_ASKS,
  MOST_SHOWN_PER_SESSION,
} from './context.constants';

/** A question put to a person in the agent's own prompt, and the ruling that put it. */
export interface PendingAsk {
  /** The tool call, as its host names it or as a digest of what it carries. */
  fingerprint: string;
  at: string;
  tool: string;
  action: string;
  target?: string;
  class: string;
  mode: string;
  reason: string;
  rule?: string;
}

export interface SessionContextState {
  /** Decision ids, each with when it was shown. */
  shown: Record<string, string>;
  asks: PendingAsk[];
}

export function emptyContextState(): SessionContextState {
  return { shown: {}, asks: [] };
}

/** The ids this session has not been shown yet, in the order given. */
export function notYetShown(
  state: SessionContextState,
  ids: readonly string[],
): string[] {
  return ids.filter((id) => state.shown[id] === undefined);
}

/** Marked shown, the oldest let go past the bound so the file never grows past it. */
export function markShown(
  state: SessionContextState,
  ids: readonly string[],
  at: string,
): SessionContextState {
  const shown = { ...state.shown, ...Object.fromEntries(ids.map((id) => [id, at])) };
  const newest = Object.entries(shown)
    .sort(([, a], [, b]) => Date.parse(b) - Date.parse(a))
    .slice(0, MOST_SHOWN_PER_SESSION);
  return { ...state, shown: Object.fromEntries(newest) };
}

/** A question kept for its answer, the expired and the oldest past the bound dropped. */
export function rememberAsk(
  state: SessionContextState,
  ask: PendingAsk,
): SessionContextState {
  const live = answerable(state.asks, ask.at).filter(
    (each) => each.fingerprint !== ask.fingerprint,
  );
  return { ...state, asks: [...live, ask].slice(-MOST_PENDING_ASKS) };
}

/** The question this tool call answers, taken off the list, or null where none is waiting. */
export function takeAsk(
  state: SessionContextState,
  fingerprint: string,
  now: string,
): { ask: PendingAsk | null; state: SessionContextState } {
  const live = answerable(state.asks, now);
  const ask = live.find((each) => each.fingerprint === fingerprint) ?? null;
  const asks = live.filter((each) => each !== ask);
  return { ask, state: { ...state, asks } };
}

/** A question older than the window is no longer one a tool call running can answer. */
function answerable(asks: readonly PendingAsk[], now: string): PendingAsk[] {
  const moment = Date.parse(now);
  return asks.filter(
    (each) => moment - Date.parse(each.at) <= minutesToMs(ASK_ANSWER_MINUTES),
  );
}
