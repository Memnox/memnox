/**
 * A session that has only read outside this machine and now changes something there has
 * turned from investigating to acting. Each step can be allowed and the turn still wants
 * a person once, because "look into the failed payment" is not "refund it".
 */
import { LOCAL_NAMESPACES } from '../constants/action-class.constants';
import { DECISION_EFFECT } from '../constants/decision.constants';
import { TOOL_CLASS } from '../discovery/classify';
import type { ActionRequest } from '../domain/action-event';
import { NOTICE_SIGNAL } from './notice.constants';
import type { SessionSignals } from './notice-state';
import type { Notice } from './unusual';

const CHANGES: readonly string[] = [
  TOOL_CLASS.WRITE,
  TOOL_CLASS.DESTRUCTIVE,
  TOOL_CLASS.COMMUNICATION,
];

/** Reads enough to call it an investigation, rather than one look before a change. */
export const TURN_AFTER_READS = 3;

/** Whether an action reaches outside this machine, which is what the turn is about. */
export function reachesOutside(action: string): boolean {
  return !LOCAL_NAMESPACES.includes(action.split('.')[0] ?? '');
}

/** A web fetch is reading the docs; an investigation reads a system, through a CLI or a tool. */
const NOT_INVESTIGATING = ['http', 'network', 'browser'];

function readsASystem(action: string): boolean {
  return (
    reachesOutside(action) && !NOT_INVESTIGATING.includes(action.split('.')[0] ?? '')
  );
}

/** Whether this action can move the turn at all, checked before anything is read. */
export function mayTurn(request: Pick<ActionRequest, 'action' | 'toolClass'>): boolean {
  if (request.toolClass === TOOL_CLASS.READ) return readsASystem(request.action);
  return CHANGES.includes(request.toolClass ?? '') && reachesOutside(request.action);
}

export interface TurnStep {
  /** What the session's signals become after this action. */
  signals: SessionSignals;
  notice: Notice | null;
}

/** Counts a read outside, or asks about the first change after enough of them. Pure. */
export function turnStep(
  request: Pick<ActionRequest, 'action' | 'toolClass'>,
  signals: SessionSignals,
): TurnStep | null {
  if (!reachesOutside(request.action)) return null;
  const reads = signals.outsideReads ?? 0;
  if (request.toolClass === TOOL_CLASS.READ) {
    // Counted up to the point it matters and no further, so a long session stops writing.
    if (!readsASystem(request.action) || signals.outsideChanged === true) return null;
    if (reads >= TURN_AFTER_READS) return null;
    return { signals: { ...signals, outsideReads: reads + 1 }, notice: null };
  }
  // A class this runtime does not know is not counted as a change, since it may be a read.
  if (!CHANGES.includes(request.toolClass ?? '')) return null;
  if (signals.outsideChanged === true) return null;
  const changed = { ...signals, outsideChanged: true };
  if (reads < TURN_AFTER_READS) return { signals: changed, notice: null };
  return {
    signals: changed,
    notice: {
      signal: NOTICE_SIGNAL.TURN,
      effect: DECISION_EFFECT.ASK,
      reason: `this session read outside this machine ${reads} times and changed nothing there, and this is the first change it makes`,
    },
  };
}
