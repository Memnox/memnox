import type { DiscoveredAgent } from './agent';
import { isHarnessKind, type DiscoveredAgentKind } from './discovery.constants';
import type { HostedAgents } from './detectors/detector';

/**
 * A harness runs other agents, so the roster says so: one row reading like Claude Code
 * while launching nine roles is a wrong report.
 */
export interface Harness {
  agentId: string;
  kind: DiscoveredAgentKind;
  /** Agent kinds it drives, as its own config named them. Never inferred from a binary. */
  runtimes: string[];
  /** Roles it defines on disk. Each is a separate principal at the seam. */
  roles: string[];
  /** Files it installed into another product's directory, with the path that proved it. */
  hooks: string[];
  /** Agent-to-agent work across machines, whose far side no local roster can see. */
  federated: boolean;
  evidence: string[];
}

export function harnessOf(
  agent: DiscoveredAgent,
  hosted: HostedAgents | undefined,
): Harness | null {
  if (!isHarnessKind(agent.kind)) return null;
  const found = hosted ?? {
    runtimes: [],
    roles: [],
    hooks: [],
    federated: false,
    evidence: agent.configPaths,
  };
  return {
    agentId: agent.id,
    kind: agent.kind,
    runtimes: [...found.runtimes],
    roles: [...found.roles],
    hooks: [...found.hooks],
    federated: found.federated,
    evidence: [...found.evidence],
  };
}

/** How many principals a harness really is, and one when it defines no roles, since zero reads as absent. */
export function principalCount(harness: Pick<Harness, 'roles'>): number {
  return Math.max(1, harness.roles.length);
}

/** One line a person repeats to a colleague, built from counts and nothing else. */
export function describeHarness(harness: Harness): string {
  const parts: string[] = [];
  const roles = harness.roles.length;
  if (roles > 0) parts.push(`${roles} role${roles === 1 ? '' : 's'}`);
  if (harness.runtimes.length > 0) parts.push(`runs ${harness.runtimes.join(', ')}`);
  const hooks = harness.hooks.length;
  if (hooks > 0) parts.push(`${hooks} hook file${hooks === 1 ? '' : 's'}`);
  if (harness.federated) parts.push('federated across machines');
  return parts.length === 0 ? 'no roles defined yet' : parts.join(' · ');
}
