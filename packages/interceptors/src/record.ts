import {
  ACTOR_TYPE,
  ENFORCEMENT_MODE,
  EVENT_SCHEMA_VERSION,
  EVENT_SURFACE,
  newEventId,
  TOOL_CLASS,
  UNNAMED_AGENT,
  UNNAMED_SESSION,
  type DecisionEffect,
  type EventRuleRef,
  type EventSink,
  type MemnoxEvent,
  type ToolClass,
} from '@memnox/core';

import type { InterceptOutcome } from './interceptor';

/**
 * The row behind `why`, `timeline`, `trace`, `collisions` and every export, written by
 * the command seams once a verdict has been reached.
 */

/**
 * The bundle and the freeze in force when the
 * command arrived, so a verdict can be replayed.
 */
export interface Provenance {
  bundleHash?: string;
  conditionsInForce?: readonly string[];
}

export interface RecordInput extends Provenance {
  outcome: InterceptOutcome;
  effect: DecisionEffect;
  reason: string;
  at: string;
  sessionId?: string;
  agent?: string;
  rule?: EventRuleRef;
  policyHash?: string;
  exitCode?: number;
  durationMs?: number;
}

const CLASSES: readonly string[] = Object.values(TOOL_CLASS);

function isToolClass(value: string): value is ToolClass {
  return CLASSES.includes(value);
}

/** A class the ledger does not know is recorded as unknown, never as a safe one. */
function classOf(value: string): ToolClass {
  return isToolClass(value) ? value : TOOL_CLASS.UNKNOWN;
}

export function commandEventFor(input: RecordInput): MemnoxEvent {
  const { outcome } = input;
  return {
    id: newEventId(),
    schemaVersion: EVENT_SCHEMA_VERSION,
    at: input.at,
    sessionId: input.sessionId ?? UNNAMED_SESSION,
    agent: input.agent ?? UNNAMED_AGENT,
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
    ...optionalFields(input),
  };
}

function optionalFields(input: RecordInput): Partial<MemnoxEvent> {
  return {
    ...(input.rule === undefined ? {} : { rule: input.rule }),
    ...(input.policyHash === undefined ? {} : { policyHash: input.policyHash }),
    ...(input.bundleHash === undefined ? {} : { bundleHash: input.bundleHash }),
    ...(input.conditionsInForce === undefined
      ? {}
      : { conditionsInForce: input.conditionsInForce }),
    ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
  };
}

/**
 * Best effort, and silent about failing: a ledger that stops the command is a tool
 * somebody uninstalls, and the gate has already decided by the time this runs.
 */
export async function record(sink: EventSink | null, input: RecordInput): Promise<void> {
  if (sink === null) return;
  try {
    await sink.append(commandEventFor(input));
  } catch {
    // Nothing to do about it here, and nothing worth interrupting the agent for.
  }
}
