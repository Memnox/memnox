import type { EnvironmentSnapshot, SnapshotServer } from './snapshot';
import type { ToolEffect } from './discovery.constants';

/**
 * Where one capability came from. Tools arrive through servers, servers arrive through
 * a config file, and by the time an agent calls something surprising nobody remembers
 * which. Every field here is read off a scan, so none of it is a guess.
 */
export interface CapabilityTrace {
  tool: string;
  server: string;
  effect: ToolEffect;
  /** Agent ids that launch the server, which is who reaches the tool. */
  reachedBy: string[];
  /** The config file that declares the server. */
  grantedBy: string;
  /**
   * The oldest scan that already held it. Absent when the oldest kept scan holds it
   * too, because "at least this long" is the honest answer and a date would not be.
   */
  firstSeen?: string;
}

/**
 * Traced against the scan history rather than a file's mtime: a config edited for an
 * unrelated reason must not make a year-old tool look like it arrived this morning.
 * History is oldest first.
 */
export function traceCapability(
  toolName: string,
  history: readonly EnvironmentSnapshot[],
): CapabilityTrace | null {
  const latest = history[history.length - 1];
  if (latest === undefined) return null;

  const found = holderOf(latest, toolName);
  if (found === null) return null;

  const oldest = history[0];
  const presentInOldest = oldest !== undefined && holderOf(oldest, toolName) !== null;
  const arrival = history.find((snapshot) => holderOf(snapshot, toolName) !== null);

  return {
    tool: toolName,
    server: found.server.name,
    effect: found.effect,
    reachedBy: found.server.agentIds,
    grantedBy: found.server.grantedBy,
    ...(presentInOldest || arrival === undefined ? {} : { firstSeen: arrival.takenAt }),
  };
}

function holderOf(
  snapshot: EnvironmentSnapshot,
  toolName: string,
): { server: SnapshotServer; effect: ToolEffect } | null {
  for (const server of snapshot.servers) {
    const tool = server.tools.find((each) => each.name === toolName);
    if (tool !== undefined) return { server, effect: tool.effect };
  }
  return null;
}

/** Every tool whose name contains the term, for a reader who half-remembers one. */
export function toolsMatching(
  snapshot: EnvironmentSnapshot,
  term: string,
): { server: string; tool: string; effect: ToolEffect }[] {
  const needle = term.toLowerCase();
  return snapshot.servers.flatMap((server) =>
    server.tools
      .filter((tool) => tool.name.toLowerCase().includes(needle))
      .map((tool) => ({ server: server.name, tool: tool.name, effect: tool.effect })),
  );
}
