import type { ActionEvent, AuditLog, Seam } from '@memnox/core';
import { DECISION_EFFECT } from '@memnox/core';
import {
  findUnusedGrants,
  proposeLeastPrivilege,
  renderProposal,
  rollUpUsage,
  type CapabilityUsage,
  type GrantedAction,
  type LeastPrivilegeProposal,
  type UnusedGrant,
  type UsageObservation,
} from '@memnox/ledger';
import type { Policy } from '@memnox/policy-engine';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** How much history the proposal is derived from unless the caller says otherwise. */
export const DEFAULT_LEARN_WINDOW_DAYS = 7;
const AUDIT_WINDOW = 10_000;

export interface RefusedAction {
  action: string;
  count: number;
}

export interface LearnResult {
  agentId: string;
  agentName: string;
  usage: CapabilityUsage[];
  unused: UnusedGrant[];
  /**
   * Attempted and refused, which is not the same as never touched. An agent repeatedly
   * refused something is misconfigured or missing an alternative, and proposing to deny
   * what a rule already denies would be noise.
   */
  refused: RefusedAction[];
  proposal: LeastPrivilegeProposal;
  /** The file a person reads, edits, applies and commits. */
  policyFile: string;
}

export interface LearnDeps {
  auditLog: AuditLog;
  /** What each agent was permitted: the rules in force plus the seams discovery found. */
  rules: () => Policy[];
  seams: () => Promise<Seam[]>;
  clock?: () => Date;
}

/**
 * Watch for a day, then say what nobody could have said before: not only what the
 * agents did, but what they never needed. Least privilege written from behaviour rather
 * than from imagination is the strongest thing the open half can do.
 */
export class LearnService {
  private readonly clock: () => Date;

  constructor(private readonly deps: LearnDeps) {
    this.clock = deps.clock ?? (() => new Date());
  }

  async learn(windowDays = DEFAULT_LEARN_WINDOW_DAYS): Promise<LearnResult[]> {
    const since = new Date(this.clock().getTime() - windowDays * MS_PER_DAY);
    const events = await this.deps.auditLog.query({
      from: since.toISOString(),
      limit: AUDIT_WINDOW,
    });
    const decisions = events.filter((event) => event.decisionEventId === undefined);
    const granted = await this.grantedActions(decisions);
    const usage = rollUpUsage(decisions.map(observe));

    const results: LearnResult[] = [];
    for (const [agentId, agentName] of namesOf(decisions)) {
      const own = usage.filter((each) => each.agentId === agentId);
      const refused = refusedBy(decisions, agentId);
      const attempted = new Set(refused.map((each) => each.action));
      /* What was tried and refused is not what was never touched, and a rule already
         refusing it needs no second rule proposing to. Filtered before the proposal is
         built, or the same action lands in both lists. */
      const unused = findUnusedGrants(
        granted.map((action) => ({ ...action, agentId })),
        own,
        windowDays,
      ).filter((grant) => !attempted.has(grant.action));
      const proposal = proposeLeastPrivilege({
        agentId,
        usage: own,
        unused,
        windowDays,
        sessions: sessionsOf(decisions, agentId),
        coverage: coverageOf(decisions, agentId),
        alwaysAsk: [...ALWAYS_ASK],
      });
      results.push({
        agentId,
        agentName,
        usage: own,
        unused,
        refused,
        proposal,
        policyFile: renderProposal(proposal),
      });
    }
    return results;
  }

  /** What was permitted: every action a rule names, plus every action a seam covers. */
  private async grantedActions(events: readonly ActionEvent[]): Promise<GrantedAction[]> {
    const actions = new Map<string, string>();
    for (const policy of this.deps.rules()) {
      for (const action of policy.match.actions) {
        actions.set(action, `rule:${policy.name}`);
      }
    }
    for (const seam of await this.deps.seams()) {
      for (const covered of seam.covers) actions.set(covered, `seam:${seam.kind}`);
    }
    // An action the agent actually attempted was reachable, whatever the rules say.
    for (const event of events) {
      if (!actions.has(event.action)) actions.set(event.action, 'observed');
    }
    return [...actions].map(([action, grantedVia]) => ({
      agentId: '',
      action,
      grantedVia,
    }));
  }
}

/** Actions that stay behind a person however often they were used. */
const ALWAYS_ASK: readonly string[] = [
  'shell.execute',
  'database.delete',
  'deploy.release',
];

function observe(event: ActionEvent): UsageObservation {
  return {
    agentId: event.agentId,
    action: event.action,
    resourceKind: event.target === undefined ? 'none' : 'target',
    resourceId: event.target ?? event.action,
    at: event.occurredAt,
    effect: event.effect,
  };
}

/** Counted per action, so "refused once" reads differently from "refused thirty times". */
function refusedBy(events: readonly ActionEvent[], agentId: string): RefusedAction[] {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.agentId !== agentId) continue;
    if (event.effect === DECISION_EFFECT.ALLOW) continue;
    counts.set(event.action, (counts.get(event.action) ?? 0) + 1);
  }
  return [...counts]
    .map(([action, count]) => ({ action, count }))
    .sort((a, b) => b.count - a.count);
}

function namesOf(events: readonly ActionEvent[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const event of events) names.set(event.agentId, event.agentName);
  return names;
}

function sessionsOf(events: readonly ActionEvent[], agentId: string): number {
  const sessions = new Set<string>();
  for (const event of events) {
    if (event.agentId !== agentId || event.sessionId === undefined) continue;
    sessions.add(event.sessionId);
  }
  return sessions.size;
}

/**
 * The share of this agent's traffic the window actually saw. Withheld attempts are
 * traffic too: an agent that kept being refused is one the window did observe.
 */
function coverageOf(events: readonly ActionEvent[], agentId: string): number {
  const own = events.filter((event) => event.agentId === agentId);
  if (own.length === 0) return 0;
  const decided = own.filter(
    (event) => event.effect === DECISION_EFFECT.ALLOW || event.matchedPolicies.length > 0,
  );
  return decided.length / own.length;
}
