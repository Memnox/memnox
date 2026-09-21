/** Two agents working on the same thing, read from what the ledger already recorded. */
import { daysToMs, minutesToMs } from '../domain/time';
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
 * is code review, which is a different product and out of scope permanently.
 */
export function concurrentWork(
  observations: readonly WorkObservation[],
  options: { now: string; windowMinutes?: number },
): Collision[] {
  const window = options.windowMinutes ?? DEFAULT_COLLISION_WINDOW_MINUTES;
  const cutoff = Date.parse(options.now) - minutesToMs(window);
  const recent = observations.filter((each) => Date.parse(each.at) >= cutoff);

  const collisions: Collision[] = [];
  for (const [target, agents] of latestTouchByTarget(recent)) {
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

/** Each agent's most recent touch per target, writing if any touch in the window wrote. */
function latestTouchByTarget(
  observations: readonly WorkObservation[],
): Map<string, Map<string, CollidingAgent>> {
  const byTarget = new Map<string, Map<string, CollidingAgent>>();
  for (const observation of observations) {
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
  return byTarget;
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
 * collision, on different branches. Proposed to a person rather than acted on, because a
 * shared file is evidence of duplication and never proof of it.
 */
export function overlappingWork(
  observations: readonly WorkObservation[],
  options: { now: string; windowDays: number; minShared?: number },
): OverlappingWork[] {
  const minShared = options.minShared ?? MINIMUM_SHARED_TARGETS;
  const cutoff = Date.parse(options.now) - daysToMs(options.windowDays);
  const writers = writersSince(observations, cutoff);

  const found: OverlappingWork[] = [];
  for (const [index, left] of writers.entries()) {
    for (const right of writers.slice(index + 1)) {
      const shared = [...left.targets].filter((target) => right.targets.has(target));
      if (shared.length < minShared) continue;
      found.push({
        agents: [describeWriter(left), describeWriter(right)],
        sharedTargets: shared.sort(),
        since: left.since < right.since ? left.since : right.since,
      });
    }
  }
  return found;
}

interface WriterActivity {
  agentId: string;
  agentName: string;
  targets: Set<string>;
  branches: Set<string>;
  since: string;
}

/** Every agent that wrote after the cutoff, with what it wrote and where. */
function writersSince(
  observations: readonly WorkObservation[],
  cutoff: number,
): WriterActivity[] {
  const byAgent = new Map<string, WriterActivity>();
  for (const observation of observations) {
    if (!observation.writing) continue;
    if (Date.parse(observation.at) < cutoff) continue;
    const existing = byAgent.get(observation.agentId);
    if (existing === undefined) {
      byAgent.set(observation.agentId, {
        agentId: observation.agentId,
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
  return [...byAgent.values()];
}

function describeWriter(writer: WriterActivity): OverlappingWork['agents'][number] {
  return {
    agentId: writer.agentId,
    agentName: writer.agentName,
    ...branchOf(writer.branches),
  };
}

/** One branch names the work; several mean the agent moved around, so none is named. */
function branchOf(branches: ReadonlySet<string>): { branch?: string } {
  if (branches.size !== 1) return {};
  const [only] = [...branches];
  return only === undefined ? {} : { branch: only };
}
