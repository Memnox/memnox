import { CHANGE_DIRECTION, CHANGE_SUBJECT } from './discovery.constants';
import type { EnvironmentChange, EnvironmentSnapshot } from './snapshot';

/**
 * The handful of changes worth interrupting somebody for. Everything else `diff` will
 * still show; an alert that fires on every ordinary install is one people turn off.
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

const WRITE_EFFECTS = ['write', 'destructive'];

export function alertsFor(changes: readonly EnvironmentChange[]): Alert[] {
  const alerts: Alert[] = [];
  for (const change of changes) {
    if (change.direction !== CHANGE_DIRECTION.WIDENS) continue;

    if (
      change.subject === CHANGE_SUBJECT.RESOURCE &&
      (change.detail.includes('secret') || change.detail.includes('credential'))
    ) {
      alerts.push({
        kind: ALERT.CREDENTIAL_EXPOSED,
        name: change.name,
        headline: `${change.name} is now reachable by an agent on this machine`,
        next: `memnox explain "${change.name}"`,
      });
      continue;
    }
    if (change.subject === CHANGE_SUBJECT.SERVER) {
      alerts.push({
        kind: ALERT.NEW_SERVER,
        name: change.name,
        headline: `a new MCP server, ${change.name}, was added`,
        next: `memnox scan --mcp ${change.name}`,
      });
      continue;
    }
    if (
      change.subject === CHANGE_SUBJECT.TOOL &&
      WRITE_EFFECTS.some((effect) => change.detail.includes(effect))
    ) {
      alerts.push({
        kind: ALERT.NEW_WRITE_TOOL,
        name: change.name,
        headline: `${change.name} can change something outside this machine`,
        next: 'memnox protect',
      });
    }
  }
  return alerts;
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
  const countFor = (snapshot: EnvironmentSnapshot, agentId: string): number =>
    snapshot.servers
      .filter((server) => server.agentIds.includes(agentId))
      .reduce((total, server) => total + server.tools.length, 0);

  for (const agent of after.agents) {
    const previous = before.agents.find((each) => each.id === agent.id);
    if (previous === undefined) continue;
    if (previous.version === agent.version) continue;

    changes.push({
      agent: agent.kind,
      before: previous.version ?? 'unknown',
      after: agent.version ?? 'unknown',
      capabilitiesBefore: countFor(before, agent.id),
      capabilitiesAfter: countFor(after, agent.id),
    });
  }
  return changes;
}

export function describeUpdate(change: VersionChange): string {
  const delta = change.capabilitiesAfter - change.capabilitiesBefore;
  const direction =
    delta > 0
      ? `and came back with ${delta} more capability(ies)`
      : delta < 0
        ? `and came back with ${Math.abs(delta)} fewer`
        : 'with the same capabilities';
  return `${change.agent} updated ${change.before} → ${change.after} ${direction} (${change.capabilitiesBefore} → ${change.capabilitiesAfter})`;
}
