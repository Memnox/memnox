/**
 * What an agent may do in each system it reaches, as the engine answers: its reads and
 * its changes, each counted by the verdict a call would meet. Counts, never a score.
 */
import { DECISION_EFFECT, type DecisionEffect } from '../constants/decision.constants';
import { changesExternalState, TOOL_CLASS, type ToolClass } from '../discovery/classify';

export interface SystemCandidate {
  action: string;
  class: ToolClass;
}

export interface SystemReach {
  /** `gh`, `railway`, or an MCP server by its name. */
  system: string;
  candidates: readonly SystemCandidate[];
}

/** How many of one kind of action meet each verdict, and how many no rule covers. */
export interface VerdictTally {
  allow: number;
  ask: number;
  deny: number;
  /** Allowed only because nothing covers them, which is not the same as permitted. */
  unruled: number;
}

export interface SystemAuthority {
  system: string;
  reads: VerdictTally;
  changes: VerdictTally;
}

export interface AuthorityVerdict {
  effect: DecisionEffect;
  matched: boolean;
}

function emptyTally(): VerdictTally {
  return { allow: 0, ask: 0, deny: 0, unruled: 0 };
}

function counted(tally: VerdictTally, verdict: AuthorityVerdict): VerdictTally {
  const next = { ...tally };
  if (verdict.effect === DECISION_EFFECT.DENY) next.deny += 1;
  else if (verdict.effect === DECISION_EFFECT.ASK) next.ask += 1;
  else next.allow += 1;
  if (!verdict.matched) next.unruled += 1;
  return next;
}

/** Each system's candidates put to the engine; an unknown action is left out of both sides. */
export function authorityOf(
  reach: readonly SystemReach[],
  decide: (candidate: SystemCandidate) => AuthorityVerdict,
): SystemAuthority[] {
  return reach.map(({ system, candidates }) => {
    let reads = emptyTally();
    let changes = emptyTally();
    for (const candidate of candidates) {
      if (candidate.class === TOOL_CLASS.READ) reads = counted(reads, decide(candidate));
      else if (changesExternalState(candidate.class))
        changes = counted(changes, decide(candidate));
    }
    return { system, reads, changes };
  });
}

/** One tally in a few words: "allowed", "asked", "refused", or the mix of them. */
export function describeTally(tally: VerdictTally): string {
  const total = tally.allow + tally.ask + tally.deny;
  if (total === 0) return 'none';
  const parts: string[] = [];
  if (tally.allow > 0) parts.push(`${tally.allow} allowed`);
  if (tally.ask > 0) parts.push(`${tally.ask} asked`);
  if (tally.deny > 0) parts.push(`${tally.deny} refused`);
  const unruled = tally.unruled > 0 ? `, ${tally.unruled} by no rule` : '';
  if (parts.length === 1) {
    const only = tally.allow > 0 ? 'allowed' : tally.ask > 0 ? 'asked' : 'refused';
    return `all ${total} ${only}${unruled}`;
  }
  return `${parts.join(', ')}${unruled}`;
}
