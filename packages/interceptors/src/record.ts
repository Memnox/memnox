import { randomUUID } from 'node:crypto';
import {
  ACTOR_TYPE,
  ENFORCEMENT_MODE,
  EVENT_SCHEMA_VERSION,
  EVENT_SURFACE,
  TOOL_CLASS,
  type DecisionEffect,
  type EventSink,
  type MemnoxEvent,
  type ToolClass,
} from '@memnox/core';
import type { InterceptOutcome } from './interceptor';

/**
 * The row behind `why`, `timeline`, `trace`, `collisions` and every export. Without it
 * the ledger has readers and no writer, and every one of those commands answers "nothing
 * recorded yet" about a machine that has been governing commands all day.
 */

export interface RecordInput {
  outcome: InterceptOutcome;
  effect: DecisionEffect;
  reason: string;
  at: string;
  sessionId?: string;
  agent?: string;
  rule?: { name: string; layer: string; file: string; line?: number };
  policyHash?: string;
  exitCode?: number;
  durationMs?: number;
}

const CLASSES: readonly string[] = Object.values(TOOL_CLASS);

/** A class the ledger does not know is recorded as unknown, never as a safe one. */
function classOf(value: string): ToolClass {
  return (CLASSES.includes(value) ? value : TOOL_CLASS.UNKNOWN) as ToolClass;
}

export function eventFor(input: RecordInput): MemnoxEvent {
  const { outcome } = input;
  return {
    id: `evt_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    schemaVersion: EVENT_SCHEMA_VERSION,
    at: input.at,
    sessionId: input.sessionId ?? 'ses_local',
    agent: input.agent ?? 'an agent',
    actorType: ACTOR_TYPE.AGENT,
    surface: outcome.binary === 'git' ? EVENT_SURFACE.GIT : EVENT_SURFACE.SHELL,
    operation: outcome.action,
    class: classOf(outcome.class),
    effect: input.effect,
    mode: ENFORCEMENT_MODE.ENFORCE,
    reason: input.reason,
    // A digest, never the arguments: an argument list is where a secret would be.
    argsDigest: outcome.argsDigest,
    ...(outcome.target === undefined ? {} : { target: outcome.target }),
    ...(input.rule === undefined ? {} : { rule: input.rule }),
    ...(input.policyHash === undefined ? {} : { policyHash: input.policyHash }),
    ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
  };
}

/**
 * Best effort, and silent about failing. A ledger that cannot be written is a lost row;
 * a ledger that stops the command is a tool somebody uninstalls. The gate has already
 * decided by the time this runs, so nothing here can change the answer.
 */
export async function record(sink: EventSink | null, input: RecordInput): Promise<void> {
  if (sink === null) return;
  try {
    await sink.append(eventFor(input));
  } catch {
    // Nothing to do about it here, and nothing worth interrupting the agent for.
  }
}
