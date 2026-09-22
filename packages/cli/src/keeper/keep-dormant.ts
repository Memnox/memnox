/**
 * Agents installed, holding reach and doing nothing: read for `status` and `explain`, and
 * mentioned by the daemon once per stretch of silence with the command that retires one.
 */
import {
  daysToMs,
  describeReach,
  DORMANT_AFTER_DAYS,
  dormantAgents,
  lastProbed,
  LEDGER_SCAN_LIMIT,
  openLedger,
  type DormantAgent,
  type EnvironmentSnapshot,
  type MemnoxEvent,
  type SnapshotStore,
} from '@memnox/core';

import { displayName, readNames, type AgentNames } from '../agents/names';
import { readKeeperState } from './keeper-state';

interface DormancySources {
  snapshot: EnvironmentSnapshot;
  /** Kept scans, oldest first: the earliest one holding an agent proves how long it was here. */
  history: readonly EnvironmentSnapshot[];
  /** What the daemon recorded as first seen, which outlives the kept scans. */
  firstSeen: Readonly<Record<string, string>>;
  now: Date;
}

/** A dormant agent with the name a person would type, so the notice's command runs as written. */
export interface NamedDormant extends DormantAgent {
  name: string;
}

/**
 * The dormant agents on this machine. A ledger that will not open answers none, because
 * silence nobody could read is not silence anybody can claim.
 */
export async function readDormant(
  home: string,
  sources: DormancySources,
): Promise<NamedDormant[]> {
  const events = await recentWork(home, sources.now);
  if (events === null) return [];
  const names = await readNames(home);
  const dormant = dormantAgents({
    snapshot: sources.snapshot,
    events,
    knownSince: knownSinceOf(sources.firstSeen, sources.history),
    now: sources.now.toISOString(),
    aliases: aliasesOf(sources.snapshot, names),
  });
  return dormant.map((agent) => ({
    ...agent,
    name: displayName(names, { id: agent.agentId, kind: agent.kind }),
  }));
}

/**
 * For a screen: the daemon's last look where there is one, since it carries the tools,
 * or else the last scan that asked the servers, or else the last scan of any kind.
 */
export async function readDormantHere(
  home: string,
  snapshots: SnapshotStore,
  now: Date,
): Promise<NamedDormant[]> {
  const state = await readKeeperState(home);
  const history = await snapshots.history();
  const snapshot =
    state.baseline.snapshot ?? lastProbed(history) ?? history[history.length - 1] ?? null;
  if (snapshot === null) return [];
  return readDormant(home, { snapshot, history, firstSeen: state.firstSeen, now });
}

/** Agent work inside the window. Config rows are left out by the store, as they are not work. */
async function recentWork(home: string, now: Date): Promise<MemnoxEvent[] | null> {
  const ledger = openLedger(home);
  if (ledger === null) return null;
  const since = new Date(now.getTime() - daysToMs(DORMANT_AFTER_DAYS)).toISOString();
  try {
    return await ledger.query({ since, limit: LEDGER_SCAN_LIMIT });
  } finally {
    ledger.close();
  }
}

/** The earlier of what the daemon recorded and the oldest kept scan holding the agent. */
function knownSinceOf(
  firstSeen: Readonly<Record<string, string>>,
  history: readonly EnvironmentSnapshot[],
): Record<string, string> {
  const known: Record<string, string> = { ...firstSeen };
  for (const snapshot of history) {
    for (const agent of snapshot.agents) {
      const was = known[agent.id];
      if (was === undefined || snapshot.takenAt < was) known[agent.id] = snapshot.takenAt;
    }
  }
  return known;
}

function aliasesOf(
  snapshot: EnvironmentSnapshot,
  names: AgentNames,
): Record<string, string[]> {
  return Object.fromEntries(
    snapshot.agents.map((agent) => [agent.id, [displayName(names, agent)]]),
  );
}

/** The ones not mentioned yet, and the list to remember: only those still silent stay on it. */
export function newlyDormant(
  dormant: readonly NamedDormant[],
  noticed: readonly string[],
): { fresh: NamedDormant[]; noticed: string[] } {
  return {
    fresh: dormant.filter((agent) => !noticed.includes(agent.agentId)),
    noticed: dormant.map((agent) => agent.agentId),
  };
}

export function dormantNotice(agent: NamedDormant): string {
  return `${agent.name} has done nothing in ${DORMANT_AFTER_DAYS} days and still holds ${describeReach(agent.reach)}. "${offboardCommand(agent.name)}" retires it.`;
}

/** The command that retires one, with a name holding a space quoted so it runs as written. */
export function offboardCommand(name: string): string {
  return `memnox agents offboard ${name.includes(' ') ? `'${name}'` : name}`;
}
