import type { ActionEvent, AuditLog, Seam } from '@memnox/core';
import { DECISION_EFFECT, UNKNOWN_AGENT_ID } from '@memnox/core';
import {
  computeDrift,
  findUnusedGrants,
  proposeLeastPrivilege,
  renderProposal,
  rollUpUsage,
  type CapabilityUsage,
  type GrantedAction,
  type LeastPrivilegeProposal,
  type DriftFinding,
  type UnusedGrant,
  type UsageObservation,
} from '@memnox/ledger';
import { matchesAny, type Policy } from '@memnox/policy-engine';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** How much history the proposal is derived from unless the caller says otherwise. */
export const DEFAULT_LEARN_WINDOW_DAYS = 7;
const AUDIT_WINDOW = 10_000;

export interface RefusedAction {
  action: string;
  count: number;
  /** First and last, so "refused once" reads differently from "refused every week". */
  first: string;
  last: string;
  /** The rules that refused it, named so the reader can go and read them. */
  rules: string[];
  /**
   * Whether any of those rules named the permitted path instead. An agent told only
   * "no" tries again next week: a rule that keeps refusing and names no alternative
   * is right and incomplete, and that is a finding about the rule.
   */
  namesAlternative: boolean;
}

/**
 * Nobody ever wrote this down. It follows from the traffic: an action allowed again
 * and again that no rule names is authority the machine has granted without anybody
 * deciding to. A candidate a person makes explicit or refuses — never a rule.
 */
export interface ImplicitAuthorization {
  action: string;
  count: number;
  sessions: number;
  first: string;
  last: string;
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
  /** Allowed repeatedly with no rule naming it. Proposed, never applied. */
  implicit: ImplicitAuthorization[];
  /**
   * What this agent did that it was not doing a window ago. Null when nothing widened,
   * which is the common case and should read as silence rather than as a clean bill.
   */
  drift: DriftFinding | null;
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
    // The window before this one is the baseline: an agent that was safe last week may
    // not be, and comparing it against itself needs no stored baseline anybody took.
    const priorSince = new Date(since.getTime() - windowDays * MS_PER_DAY);
    const prior = (
      await this.deps.auditLog.query({
        from: priorSince.toISOString(),
        to: since.toISOString(),
        limit: AUDIT_WINDOW,
      })
    ).filter((event) => event.decisionEventId === undefined);
    const granted = await this.grantedActions(decisions);
    const usage = rollUpUsage(decisions.map(observe));

    const results: LearnResult[] = [];
    for (const [agentId, agentName] of namesOf(decisions)) {
      const own = usage.filter((each) => each.agentId === agentId);
      const refused = refusedBy(decisions, agentId, this.deps.rules());
      const attempted = new Set(refused.map((each) => each.action));
      /* What was tried and refused is not what was never touched, and a rule already
         refusing it needs no second rule proposing to. Filtered before the proposal is
         built, or the same action lands in both lists. */
      const unused = findUnusedGrants(
        granted.map((action) => ({ ...action, agentId })),
        own,
        windowDays,
        // Grants come from rule patterns, so `deploy.*` counts as used by `deploy.release`.
        (pattern, action) => matchesAny([pattern], action),
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
        implicit: implicitlyAuthorized(decisions, agentId),
        drift: behaviourDrift(prior, decisions, agentId, windowDays, since.toISOString()),
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

interface RefusalTally {
  count: number;
  first: string;
  last: string;
  rules: Set<string>;
}

/** Counted per action, so "refused once" reads differently from "refused thirty times". */
function refusedBy(
  events: readonly ActionEvent[],
  agentId: string,
  rules: readonly Policy[],
): RefusedAction[] {
  const tallies = new Map<string, RefusalTally>();
  for (const event of events) {
    if (event.agentId !== agentId) continue;
    if (event.effect === DECISION_EFFECT.ALLOW) continue;
    const tally = tallies.get(event.action);
    if (tally === undefined) {
      tallies.set(event.action, {
        count: 1,
        first: event.occurredAt,
        last: event.occurredAt,
        rules: new Set(event.matchedPolicies),
      });
      continue;
    }
    tally.count += 1;
    if (event.occurredAt < tally.first) tally.first = event.occurredAt;
    if (event.occurredAt > tally.last) tally.last = event.occurredAt;
    for (const name of event.matchedPolicies) tally.rules.add(name);
  }

  const byName = new Map(rules.map((policy) => [policy.name, policy]));
  return [...tallies]
    .map(([action, tally]) => ({
      action,
      count: tally.count,
      first: tally.first,
      last: tally.last,
      rules: [...tally.rules],
      namesAlternative: [...tally.rules].some(
        (name) => byName.get(name)?.decision.alternative !== undefined,
      ),
    }))
    .sort((a, b) => b.count - a.count);
}

/**
 * What the machine has permitted without anybody deciding to: allowed, more than once,
 * and matched by no rule at all. Surfaced as a candidate so it is made explicit before
 * something goes wrong under it.
 */
function implicitlyAuthorized(
  events: readonly ActionEvent[],
  agentId: string,
): ImplicitAuthorization[] {
  const tallies = new Map<
    string,
    { count: number; sessions: Set<string>; first: string; last: string }
  >();
  for (const event of events) {
    if (event.agentId !== agentId) continue;
    if (event.effect !== DECISION_EFFECT.ALLOW) continue;
    if (event.matchedPolicies.length > 0) continue;
    const tally = tallies.get(event.action);
    if (tally === undefined) {
      tallies.set(event.action, {
        count: 1,
        sessions: new Set(event.sessionId === undefined ? [] : [event.sessionId]),
        first: event.occurredAt,
        last: event.occurredAt,
      });
      continue;
    }
    tally.count += 1;
    if (event.sessionId !== undefined) tally.sessions.add(event.sessionId);
    if (event.occurredAt < tally.first) tally.first = event.occurredAt;
    if (event.occurredAt > tally.last) tally.last = event.occurredAt;
  }
  return [...tallies]
    .filter(([, tally]) => tally.count > 1)
    .map(([action, tally]) => ({
      action,
      count: tally.count,
      sessions: tally.sessions.size,
      first: tally.first,
      last: tally.last,
    }))
    .sort((a, b) => b.count - a.count);
}

/**
 * An agent compared against its own behaviour a window ago, which is the only baseline
 * available with no account: what it reached then, and what it reaches now.
 */
function behaviourDrift(
  prior: readonly ActionEvent[],
  current: readonly ActionEvent[],
  agentId: string,
  windowDays: number,
  computedAt: string,
): DriftFinding | null {
  const before = observedBy(prior, agentId);
  // Nothing to compare against is not the same as everything being new. An agent whose
  // first window this is would otherwise read as having widened in every direction.
  if (before.tools.length === 0) return null;
  const after = observedBy(current, agentId);
  return computeDrift(
    { subjectId: agentId, windowDays, ...before, computedAt },
    { subjectId: agentId, ...after },
  );
}

/** What an agent reached in a window, off the events the seams recorded. */
function observedBy(
  events: readonly ActionEvent[],
  agentId: string,
): { surfaces: string[]; destinations: string[]; tools: string[]; models: string[] } {
  const own = events.filter((event) => event.agentId === agentId);
  return {
    surfaces: distinct(own.map((event) => event.decidedBy)),
    destinations: distinct(own.map((event) => event.target)),
    tools: distinct(own.map((event) => event.action)),
    models: distinct(own.map((event) => event.model)),
  };
}

function distinct(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => value !== undefined))];
}

/**
 * Every agent that acted, minus the pseudo-identity a rejected credential records. This
 * report reads "you granted this agent X and it used Y%", and nobody granted a token the
 * runtime could not resolve anything at all — counting it invents an agent.
 */
function namesOf(events: readonly ActionEvent[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const event of events) {
    if (event.agentId === UNKNOWN_AGENT_ID) continue;
    names.set(event.agentId, event.agentName);
  }
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
