import {
  ENFORCEMENT_MODE,
  type DecisionEffect,
  type EnforcementMode,
} from '@memnox/core';
import { versionPolicySet } from '@memnox/policy-engine';
import type { ActionGateway } from './action-gateway';
import type { RuntimeConfig } from './config';

/** Matches what `memnox status` samples, so the page and the CLI never disagree. */
const RECENT_WINDOW_EVENTS = 200;
/** How many rows the page shows; the counts above it still cover the whole window. */
const RECENT_SHOWN = 20;

export interface RecentDecision {
  occurredAt: string;
  effect: DecisionEffect;
  /** What policy decided when the mode kept it from being applied. */
  withheldEffect?: DecisionEffect;
  agentName: string;
  action: string;
  target?: string;
  reason: string;
}

export interface RuntimeStatus {
  /** The default mode; a per-environment override is not a whole-runtime state. */
  enforcement: EnforcementMode;
  policyCount: number;
  policyVersion: string;
  pendingApprovals: number;
  recentDecisions: number;
  /** Would have been stopped under enforcement — the number that decides whether arming is safe. */
  withheld: number;
  guards: string[];
  recent: RecentDecision[];
}

/**
 * Assembles what the dashboard and any status caller need in one pass. It lives
 * beside the gateway rather than in a route because tallying withheld decisions
 * is a question about the corpus, not about HTTP.
 */
export async function readRuntimeStatus(
  gateway: ActionGateway,
  config: RuntimeConfig,
): Promise<RuntimeStatus> {
  const [policies, pending, recent] = await Promise.all([
    Promise.resolve(gateway.policies()),
    gateway.approvals.pending(),
    gateway.recentAuditEvents(RECENT_WINDOW_EVENTS),
  ]);

  const withheld = recent.filter((event) => event.withheldEffect !== undefined);

  return {
    enforcement: gateway.enforcement().default ?? ENFORCEMENT_MODE.MONITOR,
    policyCount: policies.length,
    policyVersion: versionPolicySet(policies).version,
    pendingApprovals: pending.length,
    recentDecisions: recent.length,
    withheld: withheld.length,
    guards: enabledGuards(config),
    recent: recent.slice(0, RECENT_SHOWN).map((event) => ({
      occurredAt: event.occurredAt,
      effect: event.effect,
      ...(event.withheldEffect === undefined
        ? {}
        : { withheldEffect: event.withheldEffect }),
      agentName: event.agentName,
      action: event.action,
      ...(event.target === undefined ? {} : { target: event.target }),
      reason: event.reason,
    })),
  };
}

/** Same names and order the CLI prints, so one list cannot drift from the other. */
function enabledGuards(config: RuntimeConfig): string[] {
  const guards: string[] = [];
  if (config.contentShield) guards.push('content shield');
  if (config.shellGuard) guards.push('shell indirection');
  // Escalates only when callers report taint, so it is always registered.
  guards.push('taint');
  if (config.memoryEnabled) guards.push('decision memory');
  if (config.behaviorGuard) guards.push('behavior');
  if (config.trustGuard) guards.push('trust');
  if (config.verificationGuard) guards.push('verification');
  if (config.dependencyGuard) guards.push('dependencies');
  if (config.codeGraphFile !== undefined && config.protectedPaths.length > 0) {
    guards.push('blast radius');
  }
  return guards;
}
