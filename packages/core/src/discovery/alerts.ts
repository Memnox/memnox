import { CHANGE_DIRECTION, CHANGE_SUBJECT } from './discovery.constants';
import { isCredentialExposure, isWriteCapable } from './fail-on';
import type { EnvironmentSnapshot } from './snapshot';
import type { EnvironmentChange } from './snapshot-changes';

/**
 * The handful of changes worth interrupting somebody for, because an alert that fires on
 * every ordinary install is one people turn off. Everything else `diff` still shows.
 */
export const ALERT = {
  /** A credential became visible to something here. The one people page about. */
  CREDENTIAL_EXPOSED: 'credential-exposed',
  /** A server arrived that nothing has a rule for. */
  NEW_SERVER: 'new-server',
  /** A tool arrived that can change something outside this machine. */
  NEW_WRITE_TOOL: 'new-write-tool',
  /** An agent updated and came back holding more than it held before. */
  AGENT_WIDENED: 'agent-widened',
  /** Something that runs other agents gained another one, or reached another machine. */
  HARNESS_WIDENED: 'harness-widened',
} as const;

export type AlertKind = (typeof ALERT)[keyof typeof ALERT];

export interface Alert {
  kind: AlertKind;
  name: string;
  /** The sentence a person reads, in their words rather than the model's. */
  headline: string;
  /** What to do about it, because an alert with no next step is only noise. */
  next: string;
}

export function alertsFor(changes: readonly EnvironmentChange[]): Alert[] {
  return changes.flatMap((change) => {
    if (change.direction !== CHANGE_DIRECTION.WIDENS) return [];
    const alert = alertFor(change);
    return alert === null ? [] : [alert];
  });
}

/** The first kind that fits, in order of how urgently somebody should hear it. */
function alertFor(change: EnvironmentChange): Alert | null {
  const name = change.name;
  if (isCredentialExposure(change)) {
    return {
      kind: ALERT.CREDENTIAL_EXPOSED,
      name,
      headline: `${name} is now reachable by an agent on this machine`,
      next: `memnox explain "${name}"`,
    };
  }
  if (change.subject === CHANGE_SUBJECT.SERVER) {
    return {
      kind: ALERT.NEW_SERVER,
      name,
      headline: `a new MCP server, ${name}, was added`,
      next: `memnox scan --mcp ${name}`,
    };
  }
  // A new role arrives without any client config changing, so nothing else here fires for it.
  if (change.subject === CHANGE_SUBJECT.HARNESS) {
    return {
      kind: ALERT.HARNESS_WIDENED,
      name,
      headline: `${name} now runs more than it did: ${change.detail}`,
      next: `memnox explain ${name}`,
    };
  }
  if (!isWriteCapable(change)) return null;
  return {
    kind: ALERT.NEW_WRITE_TOOL,
    name,
    headline: `${name} can change something outside this machine`,
    next: 'memnox protect',
  };
}

export interface VersionChange {
  agent: string;
  before: string;
  after: string;
  capabilitiesBefore: number;
  capabilitiesAfter: number;
}

/**
 * An agent updating itself is the quietest way authority grows: nobody granted
 * anything, and the same product now reaches more. Reported as a before and after
 * count, which is the only honest way to say it.
 */
export function agentUpdates(
  before: EnvironmentSnapshot,
  after: EnvironmentSnapshot,
): VersionChange[] {
  const changes: VersionChange[] = [];
  for (const agent of after.agents) {
    const previous = before.agents.find((each) => each.id === agent.id);
    if (previous === undefined) continue;
    if (previous.version === agent.version) continue;

    changes.push({
      agent: agent.kind,
      before: previous.version ?? 'unknown',
      after: agent.version ?? 'unknown',
      capabilitiesBefore: toolCountFor(before, agent.id),
      capabilitiesAfter: toolCountFor(after, agent.id),
    });
  }
  return changes;
}

function toolCountFor(snapshot: EnvironmentSnapshot, agentId: string): number {
  return snapshot.servers
    .filter((server) => server.agentIds.includes(agentId))
    .reduce((total, server) => total + server.tools.length, 0);
}

export function describeUpdate(change: VersionChange): string {
  const delta = change.capabilitiesAfter - change.capabilitiesBefore;
  return `${change.agent} updated ${change.before} → ${change.after} ${describeDelta(delta)} (${change.capabilitiesBefore} → ${change.capabilitiesAfter})`;
}

function describeDelta(delta: number): string {
  if (delta > 0) return `and came back with ${delta} more capability(ies)`;
  if (delta < 0) return `and came back with ${Math.abs(delta)} fewer`;
  return 'with the same capabilities';
}
