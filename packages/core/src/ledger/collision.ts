import {
  DEFAULT_COLLISION_WINDOW_MINUTES,
  MINIMUM_SHARED_TARGETS,
} from './ledger.constants';

/**
 * One thing an agent touched, as the ledger already recorded it. Whether it was a
 * write is the caller's call: the ledger does not own the action vocabulary, and a
 * detector that guessed at it would report collisions between two readers.
 */
export interface WorkObservation {
  agentId: string;
  agentName: string;
  target: string;
  at: string;
  writing: boolean;
  branch?: string;
}

export interface CollidingAgent {
  agentId: string;
  agentName: string;
  /** The most recent touch, which is what makes "writing, 12m" sayable. */
  at: string;
  writing: boolean;
  branch?: string;
}

export interface Collision {
  target: string;
  agents: CollidingAgent[];
}

/**
 * Two agents inside the same target inside one window, at least one of them writing.
 * Reported, never refereed: which of them is right is a diff somebody opens, and that
 * is code review — a different product, and out of scope permanently.
 */
export function concurrentWork(
  observations: readonly WorkObservation[],
  options: { now: string; windowMinutes?: number },
): Collision[] {
  const window = options.windowMinutes ?? DEFAULT_COLLISION_WINDOW_MINUTES;
  const cutoff = Date.parse(options.now) - window * 60_000;
  const recent = observations.filter((each) => Date.parse(each.at) >= cutoff);

  const byTarget = new Map<string, Map<string, CollidingAgent>>();
  for (const observation of recent) {
    const agents = byTarget.get(observation.target) ?? new Map<string, CollidingAgent>();
    const existing = agents.get(observation.agentId);
    if (existing === undefined || existing.at < observation.at) {
      agents.set(observation.agentId, {
        agentId: observation.agentId,
        agentName: observation.agentName,
        at: observation.at,
        writing: observation.writing || (existing !== undefined && existing.writing),
        ...(observation.branch === undefined ? {} : { branch: observation.branch }),
      });
    } else if (observation.writing) {
      existing.writing = true;
    }
    byTarget.set(observation.target, agents);
  }

  const collisions: Collision[] = [];
  for (const [target, agents] of byTarget) {
    const involved = [...agents.values()];
    if (involved.length < 2) continue;
    // Two readers in one file is a normal Tuesday. One writer makes it a collision.
    if (!involved.some((agent) => agent.writing)) continue;
    collisions.push({
      target,
      agents: involved.sort((a, b) => a.at.localeCompare(b.at)),
    });
  }
  return collisions.sort((a, b) => a.target.localeCompare(b.target));
}

export interface OverlappingWork {
  agents: { agentId: string; agentName: string; branch?: string }[];
  /** The files both of them changed, which is the whole of the evidence. */
  sharedTargets: string[];
  /** The earliest touch on either side, so "started three days apart" is sayable. */
  since: string;
}

/**
 * Two agents building the same thing: overlapping targets over a longer window than a
 * collision, on different branches. Proposed to a person rather than acted on — a
 * shared file is evidence of duplication and never proof of it.
 */
export function overlappingWork(
  observations: readonly WorkObservation[],
  options: { now: string; windowDays: number; minShared?: number },
): OverlappingWork[] {
  const minShared = options.minShared ?? MINIMUM_SHARED_TARGETS;
  const cutoff = Date.parse(options.now) - options.windowDays * 24 * 60 * 60_000;

  const byAgent = new Map<
    string,
    { agentName: string; targets: Set<string>; branches: Set<string>; since: string }
  >();
  for (const observation of observations) {
    if (!observation.writing) continue;
    if (Date.parse(observation.at) < cutoff) continue;
    const existing = byAgent.get(observation.agentId);
    if (existing === undefined) {
      byAgent.set(observation.agentId, {
        agentName: observation.agentName,
        targets: new Set([observation.target]),
        branches: new Set(observation.branch === undefined ? [] : [observation.branch]),
        since: observation.at,
      });
      continue;
    }
    existing.targets.add(observation.target);
    if (observation.branch !== undefined) existing.branches.add(observation.branch);
    if (observation.at < existing.since) existing.since = observation.at;
  }

  const found: OverlappingWork[] = [];
  const agents = [...byAgent.entries()];
  for (let i = 0; i < agents.length; i += 1) {
    for (let j = i + 1; j < agents.length; j += 1) {
      const [leftId, left] = agents[i] as [string, (typeof agents)[number][1]];
      const [rightId, right] = agents[j] as [string, (typeof agents)[number][1]];
      const shared = [...left.targets].filter((target) => right.targets.has(target));
      if (shared.length < minShared) continue;
      found.push({
        agents: [
          { agentId: leftId, agentName: left.agentName, ...branchOf(left.branches) },
          { agentId: rightId, agentName: right.agentName, ...branchOf(right.branches) },
        ],
        sharedTargets: shared.sort(),
        since: left.since < right.since ? left.since : right.since,
      });
    }
  }
  return found;
}

/** One branch names the work; several mean the agent moved around, so none is named. */
function branchOf(branches: Set<string>): { branch?: string } {
  if (branches.size !== 1) return {};
  const [only] = [...branches];
  return only === undefined ? {} : { branch: only };
}
