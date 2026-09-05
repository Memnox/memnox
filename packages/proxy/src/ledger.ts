import { randomUUID } from 'node:crypto';
import {
  ACTOR_TYPE,
  classifyTool,
  DECISION_EFFECT,
  ENFORCEMENT_MODE,
  EVENT_SCHEMA_VERSION,
  EVENT_SURFACE,
  EXECUTION,
  SqliteEventStore,
  type EventSink,
  type MemnoxEvent,
} from '@memnox/core';
import { MCP_ACTION_PREFIX } from './firewall.constants';
import type { McpCallRecord } from './result-guard';

/**
 * The row behind `why`, `timeline` and `trace` for a proxied call. Without it the
 * ledger holds the shell and git seams alone, and "what did this agent do" answers
 * short about an agent whose whole day went through an MCP server.
 */

export interface LedgerContext {
  /** Groups a client's calls, so a timeline reads as one session rather than a list. */
  sessionId?: string;
  /** The MCP client, where the wrapper was told. Never a credential. */
  agent?: string;
}

/**
 * The action name the gate matched on, so `why` names the same thing the rule did.
 * `call-authorizer` builds `mcp.<tool>` and this must not drift from it.
 */
export function operationFor(tool: string): string {
  return `${MCP_ACTION_PREFIX}.${tool}`;
}

export function eventFor(
  record: McpCallRecord,
  at: string,
  context: LedgerContext = {},
): MemnoxEvent {
  const blocked = record.effect !== DECISION_EFFECT.ALLOW;
  return {
    id: `evt_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    schemaVersion: EVENT_SCHEMA_VERSION,
    at,
    sessionId: context.sessionId ?? 'ses_local',
    agent: context.agent ?? 'an agent',
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
    /* The layer and file are what this seam can honestly say: a matched policy carries
       its name and nothing else, the same placeholder the interceptors write. */
    ...(record.rule === undefined
      ? {}
      : { rule: { name: record.rule, layer: 'project', file: 'policy' } }),
  };
}

/**
 * Best effort, and silent about failing — the same bargain the interceptors make. A
 * ledger that cannot be written is a lost row; a ledger that breaks the JSON-RPC
 * stream is a proxy that wedges somebody's agent. The verdict has already been
 * applied by the time this runs, so nothing here can change what happened.
 */
export function recordToLedger(
  sink: EventSink,
  record: McpCallRecord,
  at: string,
  context: LedgerContext = {},
): void {
  try {
    void sink.append(eventFor(record, at, context)).catch(() => {
      // Nothing to do about it here, and nothing worth interrupting the agent for.
    });
  } catch {
    // Same again: a row is not worth a wedged proxy.
  }
}

/** The ledger, or null when it will not open. A lost row never stops a call. */
export function openLedger(home: string): SqliteEventStore | null {
  try {
    return SqliteEventStore.forHome(home);
  } catch {
    return null;
  }
}
