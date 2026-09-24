import {
  DECISION_EFFECT,
  EXECUTION,
  UNNAMED_AGENT,
  type MemnoxEvent,
} from '@memnox/core';

import { CLOUD_EVENT, eventOf, MAX_POST, type CloudEvent } from './cloud-event';

/**
 * The rows one ledger action becomes on the wire: the action, the session it opened,
 * and for a held call the approval asked and resolved. A digest, never the arguments.
 */

/** How an approval ended, in the words the control plane's inbox reads. */
const APPROVAL_ENDING = {
  APPROVED: 'approved',
  DENIED: 'denied',
  TIMED_OUT: 'timed-out',
} as const;

// The terminal, because that is the only place this machine holds a call.
const APPROVAL_CHANNEL = 'terminal';

interface Ending {
  outcome: string;
  by?: string;
}

/** A batch that fits one post, and the actions it covers, so the cursor moves no further. */
export interface FittedBatch {
  drafts: CloudEvent[];
  through: MemnoxEvent[];
}

/**
 * One action, in the kind the control plane's activity projection reads. The payload's
 * field names are the projection's, spelled out here rather than left to match by luck.
 */
export function draftFrom(event: MemnoxEvent): CloudEvent {
  return eventOf({
    kind: CLOUD_EVENT.ACTION_RECORDED,
    // Stable across a resend, which is what lets the control plane deduplicate.
    dedupKey: event.id,
    // The action's own id: `decisions` and `results` are keyed on it.
    subjectId: event.id,
    actorType: event.actorType,
    occurredAt: Date.parse(event.at),
    agentSessionId: event.sessionId,
    payload: { ...actionOf(event), ...verdictOf(event), ...resultOf(event) },
  });
}

/**
 * As many actions as fit, with every row each implies, counted in rows rather than
 * actions so the batch is not refused. The cursor advances only past what was included.
 */
export function fitting(events: readonly MemnoxEvent[]): FittedBatch {
  const sessions = new Set<string>();
  const through: MemnoxEvent[] = [];
  let rows = 0;

  for (const event of events) {
    const cost =
      1 + (sessions.has(event.sessionId) ? 0 : 1) + approvalsFrom(event).length;
    if (rows + cost > MAX_POST) break;
    rows += cost;
    sessions.add(event.sessionId);
    through.push(event);
  }

  // Sessions first and approvals after their action, so no row cites one not yet sent.
  return {
    drafts: [
      ...sessionsFrom(through),
      ...through.flatMap((event) => [draftFrom(event), ...approvalsFrom(event)]),
    ],
    through,
  };
}

/**
 * The agent, and nothing where the seam could not tell which one called it: the
 * control plane makes an agent of every name it is sent, and "an agent" names nobody.
 */
function agentOf(event: MemnoxEvent, ...keys: readonly string[]): Record<string, string> {
  if (event.agent === UNNAMED_AGENT || event.agent === '') return {};
  return Object.fromEntries(keys.map((key) => [key, event.agent]));
}

function actionOf(event: MemnoxEvent): Record<string, unknown> {
  return {
    // Both projections key their rows on this and neither falls back to anything.
    ...agentOf(event, 'agentId'),
    surface: event.surface,
    operation: event.operation,
    classes: [event.class],
    ...(event.target === undefined ? {} : { resourceRef: event.target }),
    ...(event.argsDigest === undefined ? {} : { argsDigest: event.argsDigest }),
  };
}

/** The verdict, and which rules and freeze it was decided under, so it can be replayed. */
function verdictOf(event: MemnoxEvent): Record<string, unknown> {
  return {
    effect: event.effect,
    finalEffect: finalEffectOf(event),
    reason: event.reason,
    ...(event.rule === undefined ? {} : { ruleId: event.rule.name }),
    ...(event.policyHash === undefined ? {} : { policyHash: event.policyHash }),
    ...(event.bundleHash === undefined ? {} : { bundleHash: event.bundleHash }),
    ...(event.conditionsInForce === undefined
      ? {}
      : { conditionIds: [...event.conditionsInForce] }),
    ...(event.alternative === undefined ? {} : { alternative: event.alternative.action }),
  };
}

function resultOf(event: MemnoxEvent): Record<string, unknown> {
  const ranFor = event.durationMs;
  return {
    ...(event.exitCode === undefined
      ? {}
      : { exitCode: event.exitCode, errored: event.exitCode !== 0 }),
    ...(ranFor === undefined ? {} : { startedAt: Date.parse(event.at) - ranFor }),
    // Only where the agent reported it, so an unpriced action reads as unknown, never free.
    ...(event.costUsd === undefined ? {} : { costUsd: event.costUsd }),
  };
}

/** The id an action's approval is filed under, on both sides and across resends. */
function approvalIdFor(event: MemnoxEvent): string {
  return `apr_${event.id}`;
}

/** Whether a held call has an ending yet. An unanswered one stays open, correctly. */
function endingOf(event: MemnoxEvent): Ending | null {
  if (event.authorizedBy !== undefined) {
    return { outcome: APPROVAL_ENDING.APPROVED, by: event.authorizedBy };
  }
  if (event.execution === EXECUTION.TIMED_OUT) {
    return { outcome: APPROVAL_ENDING.TIMED_OUT };
  }
  // Held, and stopped: somebody said no, or nothing answered and the hold expired.
  if (event.execution === EXECUTION.BLOCKED) return { outcome: APPROVAL_ENDING.DENIED };
  return null;
}

/**
 * What the boundary finally did, as against what it first said: an `ask` somebody
 * released ran, and reporting it as `ask` leaves it in the console as still waiting.
 */
function finalEffectOf(event: MemnoxEvent): string {
  if (event.effect !== DECISION_EFFECT.ASK) return event.effect;
  const ending = endingOf(event);
  if (ending === null) return event.effect;
  return ending.outcome === APPROVAL_ENDING.APPROVED
    ? DECISION_EFFECT.ALLOW
    : DECISION_EFFECT.DENY;
}

/**
 * The approval rows an action implies, derived from the action itself because there is
 * no approval table here. The control plane builds its inbox from them.
 */
function approvalsFrom(event: MemnoxEvent): CloudEvent[] {
  if (event.effect !== DECISION_EFFECT.ASK) return [];
  const id = approvalIdFor(event);
  const asked = eventOf({
    kind: CLOUD_EVENT.APPROVAL_REQUESTED,
    dedupKey: id,
    subjectId: id,
    actorType: event.actorType,
    occurredAt: Date.parse(event.at),
    agentSessionId: event.sessionId,
    payload: {
      actionId: event.id,
      channel: APPROVAL_CHANNEL,
      ...(event.rule === undefined ? {} : { scope: event.rule.name }),
    },
  });
  const ending = endingOf(event);
  return ending === null ? [asked] : [asked, resolvedOf(event, ending)];
}

function resolvedOf(event: MemnoxEvent, ending: Ending): CloudEvent {
  const id = approvalIdFor(event);
  return eventOf({
    kind: CLOUD_EVENT.APPROVAL_RESOLVED,
    dedupKey: `${id}:resolved`,
    subjectId: id,
    actorType: event.actorType,
    occurredAt: Date.parse(event.at),
    agentSessionId: event.sessionId,
    payload: {
      outcome: ending.outcome,
      ...(ending.by === undefined ? {} : { resolvedBy: ending.by }),
    },
  });
}

/**
 * One row per session the batch mentions, from its earliest event, because the ledger
 * has no session table. Keyed on the session, so a later batch deduplicates against it.
 */
function sessionsFrom(events: readonly MemnoxEvent[]): CloudEvent[] {
  const opening = new Map<string, MemnoxEvent>();
  for (const event of events) {
    const held = opening.get(event.sessionId);
    if (held === undefined || event.at < held.at) opening.set(event.sessionId, event);
  }
  return [...opening.values()].map((event) =>
    eventOf({
      kind: CLOUD_EVENT.SESSION_STARTED,
      dedupKey: `session:${event.sessionId}`,
      subjectId: event.sessionId,
      actorType: event.actorType,
      occurredAt: Date.parse(event.at),
      agentSessionId: event.sessionId,
      payload: agentOf(event, 'agentId', 'agentKind'),
    }),
  );
}
