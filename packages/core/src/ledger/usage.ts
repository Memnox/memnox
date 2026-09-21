/** What each agent actually did with what it was granted, and what it never touched. */
import { DECISION_EFFECT, type DecisionEffect } from '../constants/decision.constants';
import type { MemnoxEvent } from '../event/event';

/** What each agent actually did, rolled up as it is written rather than scanned later. */
export interface CapabilityUsage {
  agentId: string;
  action: string;
  resourceKind: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  distinctResources: number;
}

/** An agent granted the cloud and the database that touched neither is a rule waiting. */
export interface UnusedGrant {
  agentId: string;
  action: string;
  /** Where the grant came from: a surface discovery found, or a rule that permits it. */
  grantedVia: string;
  observedWindowDays: number;
  neverUsed: true;
}

export interface UsageObservation {
  agentId: string;
  action: string;
  resourceKind: string;
  resourceId: string;
  at: string;
  effect: DecisionEffect;
}

/** Ledger rows as the usage roll-up reads them, mapped beside the shape they produce. */
export function usageFrom(events: readonly MemnoxEvent[]): UsageObservation[] {
  return events.map((event) => ({
    agentId: event.agent,
    action: event.operation,
    resourceKind: event.surface,
    resourceId: event.target ?? event.operation,
    at: event.at,
    effect: event.effect,
  }));
}

/**
 * Only what actually proceeded counts as use. A denied attempt proves the agent
 * wanted the reach, not that it needed it, and counting it would defeat the point.
 */
export function rollUpUsage(
  observations: readonly UsageObservation[],
): CapabilityUsage[] {
  const byKey = new Map<string, CapabilityUsage & { resources: Set<string> }>();
  for (const observation of observations) {
    if (observation.effect !== DECISION_EFFECT.ALLOW) continue;
    const key = `${observation.agentId}|${observation.action}|${observation.resourceKind}`;
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, {
        agentId: observation.agentId,
        action: observation.action,
        resourceKind: observation.resourceKind,
        count: 1,
        firstSeen: observation.at,
        lastSeen: observation.at,
        distinctResources: 1,
        resources: new Set([observation.resourceId]),
      });
      continue;
    }
    existing.count += 1;
    existing.resources.add(observation.resourceId);
    existing.distinctResources = existing.resources.size;
    if (observation.at < existing.firstSeen) existing.firstSeen = observation.at;
    if (observation.at > existing.lastSeen) existing.lastSeen = observation.at;
  }
  return [...byKey.values()].map(({ resources: _resources, ...usage }) => usage);
}

export interface GrantedAction {
  agentId: string;
  action: string;
  grantedVia: string;
}

/** The complement: what was reachable, minus what was touched, over a stated window. */
export function findUnusedGrants(
  granted: readonly GrantedAction[],
  usage: readonly CapabilityUsage[],
  observedWindowDays: number,
  /** Grants are patterns and events are actions, so `deploy.*` has to match `deploy.release`. */
  matches: (pattern: string, action: string) => boolean = (pattern, action) =>
    pattern === action,
): UnusedGrant[] {
  return granted
    .filter(
      (grant) =>
        !usage.some(
          (each) => each.agentId === grant.agentId && matches(grant.action, each.action),
        ),
    )
    .map((grant) => ({
      agentId: grant.agentId,
      action: grant.action,
      grantedVia: grant.grantedVia,
      observedWindowDays,
      neverUsed: true as const,
    }));
}
