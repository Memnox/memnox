import {
  ACTOR_TYPE,
  classifyTool,
  DECISION_EFFECT,
  ENFORCEMENT_MODE,
  EVENT_SCHEMA_VERSION,
  EVENT_SURFACE,
  EXECUTION,
  localRuleRef,
  newEventId,
  UNNAMED_AGENT,
  UNNAMED_SESSION,
  type EventSink,
  type MemnoxEvent,
} from '@memnox/core';

import { MCP_ACTION_PREFIX } from './firewall.constants';
import type { McpCallRecord } from './result-guard';

/** The row behind `why`, `timeline` and `trace` for a proxied call, one per call. */

export interface LedgerContext {
  /** Groups a client's calls, so a timeline reads as one session rather than a list. */
  sessionId?: string;
  /** The MCP client, where the wrapper was told. Never a credential. */
  agent?: string;
}

/**
 * The action name the gate matches on, so a rule,
 * a budget and `why` all name the same thing.
 */
export function operationFor(tool: string): string {
  return `${MCP_ACTION_PREFIX}.${tool}`;
}

export function callEventFor(
  record: McpCallRecord,
  at: string,
  context: LedgerContext = {},
): MemnoxEvent {
  const blocked = record.effect !== DECISION_EFFECT.ALLOW;
  return {
    id: newEventId(),
    schemaVersion: EVENT_SCHEMA_VERSION,
    at,
    sessionId: context.sessionId ?? UNNAMED_SESSION,
    agent: context.agent ?? UNNAMED_AGENT,
    actorType: ACTOR_TYPE.AGENT,
    surface: EVENT_SURFACE.MCP,
    operation: operationFor(record.tool),
    // The server, which is what the call reached through and what the rule scoped on.
    target: record.server,
    class: classifyTool({ name: record.tool }).class,
    effect: record.effect,
    mode: ENFORCEMENT_MODE.ENFORCE,
    reason: record.reason,
    // A digest, never the arguments: an argument list is where a secret would be.
    argsDigest: record.argsDigest,
    execution: blocked ? EXECUTION.BLOCKED : EXECUTION.COMPLETED,
    ...(record.rule === undefined ? {} : { rule: localRuleRef(record.rule) }),
  };
}

/**
 * Best effort and silent about failing, as the interceptors are: a lost row costs less
 * than a broken JSON-RPC stream, and the verdict is already applied by now.
 */
export function recordToLedger(
  sink: EventSink,
  record: McpCallRecord,
  at: string,
  context: LedgerContext = {},
): void {
  try {
    void sink.append(callEventFor(record, at, context)).catch(() => {
      // Nothing to do about it here, and nothing worth interrupting the agent for.
    });
  } catch {
    // Same again: a row is not worth a wedged proxy.
  }
}
