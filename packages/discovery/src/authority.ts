import { TOOL_EFFECT } from './discovery.constants';
import type { EnvironmentSnapshot, SnapshotServer } from './snapshot';

/** How much external write capability the machine held at one moment. */
export interface AuthorityPoint {
  at: string;
  /** Tools that can change something outside this machine, write and destructive. */
  externalWrite: number;
}

/** One server, and how much of the movement it accounts for. */
export interface AuthorityContributor {
  server: string;
  added: number;
  /** The config file that launches it, which is the answer to "who granted this". */
  grantedBy: string;
}

export interface AuthorityTrend {
  points: AuthorityPoint[];
  /** First to last, in capability rather than in percent. */
  added: number;
  /**
   * Absent when the first point held nothing. A percentage off a zero denominator is
   * a number somebody would quote, and it would mean nothing.
   */
  percent?: number;
  /** Largest first. Every one of these was somebody unblocking themselves. */
  contributors: AuthorityContributor[];
}

/**
 * No single change is alarming. A server here, a scope there, and over two quarters
 * the estate is unrecognisable with nothing having recorded the direction of travel.
 *
 * Measured off the snapshots already kept, so it needs no account and no network, and
 * every increase is attached to the server that caused it.
 */
export function authorityTrend(
  snapshots: readonly EnvironmentSnapshot[],
): AuthorityTrend {
  const ordered = [...snapshots].sort((a, b) => a.takenAt.localeCompare(b.takenAt));
  const points = ordered.map((snapshot) => ({
    at: snapshot.takenAt,
    externalWrite: externalWriteIn(snapshot),
  }));

  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  if (first === undefined || last === undefined || first === last) {
    return { points, added: 0, contributors: [] };
  }

  const added =
    (points[points.length - 1]?.externalWrite ?? 0) - (points[0]?.externalWrite ?? 0);
  const base = points[0]?.externalWrite ?? 0;
  return {
    points,
    added,
    ...(base === 0 ? {} : { percent: Math.round((added / base) * 100) }),
    contributors: contributorsBetween(first, last),
  };
}

function externalWriteIn(snapshot: EnvironmentSnapshot): number {
  return snapshot.servers.reduce((total, server) => total + writeToolsIn(server), 0);
}

function writeToolsIn(server: SnapshotServer): number {
  return server.tools.filter(
    (tool) =>
      tool.effect === TOOL_EFFECT.WRITE || tool.effect === TOOL_EFFECT.DESTRUCTIVE,
  ).length;
}

/** Which servers account for the movement, largest first, with the file that named them. */
function contributorsBetween(
  before: EnvironmentSnapshot,
  after: EnvironmentSnapshot,
): AuthorityContributor[] {
  const priorByName = new Map(before.servers.map((server) => [server.name, server]));
  const contributors: AuthorityContributor[] = [];

  for (const server of after.servers) {
    const prior = priorByName.get(server.name);
    const added = writeToolsIn(server) - (prior === undefined ? 0 : writeToolsIn(prior));
    if (added <= 0) continue;
    contributors.push({ server: server.name, added, grantedBy: server.grantedBy });
  }
  return contributors.sort(
    (a, b) => b.added - a.added || a.server.localeCompare(b.server),
  );
}
