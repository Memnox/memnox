/**
 * The ledger rows for a session put under suspicion and let out of it, so `why` and
 * `timeline` can say why a push was asked about an hour after an issue was read.
 */
import { ENFORCEMENT_MODE } from '../constants/enforcement.constants';
import { DECISION_EFFECT } from '../constants/decision.constants';
import { TOOL_CLASS } from '../discovery/classify';
import {
  ACTOR_TYPE,
  EVENT_SCHEMA_VERSION,
  EVENT_SURFACE,
  type MemnoxEvent,
} from '../event/event';
import { newEventId } from '../event/seam-row';
import { NOTICE_OPERATION } from './notice.constants';
import type { Taint } from './notice-state';

export interface TaintRowInput {
  sessionId: string;
  agent: string;
  taint: Taint;
  at: string;
}

export interface TaintClearedInput extends TaintRowInput {
  /** The person who cleared it. Absent means the window lapsed on its own. */
  by?: string;
}

export function taintedRow(input: TaintRowInput): MemnoxEvent {
  return {
    ...rowBase(input),
    actorType: ACTOR_TYPE.AGENT,
    operation: NOTICE_OPERATION.TAINTED,
    reason:
      `a tool result from ${input.taint.source} read like instructions, so outward and ` +
      `destructive actions need a person until ${input.taint.until}`,
  };
}

export function taintClearedRow(input: TaintClearedInput): MemnoxEvent {
  const by = input.by;
  return {
    ...rowBase(input),
    actorType: by === undefined ? ACTOR_TYPE.AUTOMATION : ACTOR_TYPE.HUMAN,
    operation: NOTICE_OPERATION.TAINT_CLEARED,
    reason:
      by === undefined
        ? `the window after ${input.taint.source} read like instructions has passed`
        : `${by} cleared the suspicion ${input.taint.source} put on this session`,
    ...(by === undefined ? {} : { authorizedBy: by }),
  };
}

function rowBase(
  input: TaintRowInput,
): Omit<MemnoxEvent, 'actorType' | 'operation' | 'reason'> {
  return {
    id: newEventId(),
    schemaVersion: EVENT_SCHEMA_VERSION,
    at: input.at,
    sessionId: input.sessionId,
    agent: input.agent,
    surface: EVENT_SURFACE.MCP,
    target: input.taint.source,
    class: TOOL_CLASS.READ,
    effect: DECISION_EFFECT.ALLOW,
    mode: ENFORCEMENT_MODE.ENFORCE,
  };
}
