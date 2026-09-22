/**
 * Agents nobody is using that could still act: installed, holding write tools, credentials
 * or hooks, and silent in the ledger for a month. Each is standing authority with no work.
 */
import { agentNameIn } from '../discovery/agent';
import { SENSITIVITY, TOOL_EFFECT } from '../discovery/discovery.constants';
import type { EnvironmentSnapshot, SnapshotAgent } from '../discovery/snapshot';
import { daysToMs } from '../domain/time';
import type { MemnoxEvent } from '../event/event';

/** A month of silence, long enough to outlast a holiday and short enough to matter. */
export const DORMANT_AFTER_DAYS = 30;

/** How the proxy names a call when nobody told it which agent made it. */
const PROXY_AGENT_PREFIX = 'mcp:';

/** Effects that change something outside the machine, which is what makes a server reach. */
const WRITE_EFFECTS: readonly string[] = [TOOL_EFFECT.WRITE, TOOL_EFFECT.DESTRUCTIVE];

/** What an agent still holds, counted, because "has reach" alone is not arguable. */
export interface AgentReach {
  /** Servers it launches that carry at least one write or destructive tool. */
  writeServers: string[];
  /** Credential files and secrets it can read. */
  credentials: number;
  /** Hook files a harness installed into other products. */
  hooks: string[];
}

export interface DormantAgent {
  agentId: string;
  kind: string;
  reach: AgentReach;
  /** Since when this machine has known the agent, which bounds how long it can be silent. */
  knownSince: string;
}

export interface DormancyInput {
  snapshot: EnvironmentSnapshot;
  /** Agent work since `now` less the window. Config rows are not work and must not be here. */
  events: readonly MemnoxEvent[];
  /** Agent id to the earliest moment this machine saw it. Absent means not provably old. */
  knownSince: Readonly<Record<string, string>>;
  now: string;
  /** Agent id to the names a person gave it, which a ledger row may carry instead. */
  aliases?: Readonly<Record<string, readonly string[]>>;
  days?: number;
}

/** Every agent silent for the whole window while it still holds something. */
export function dormantAgents(input: DormancyInput): DormantAgent[] {
  const days = input.days ?? DORMANT_AFTER_DAYS;
  const cutoff = Date.parse(input.now) - daysToMs(days);
  return input.snapshot.agents.flatMap((agent) => {
    const knownSince = input.knownSince[agent.id];
    // Nobody can say an agent was silent for a month before anybody was looking.
    if (knownSince === undefined || Date.parse(knownSince) > cutoff) return [];
    const reach = agentReachOf(input.snapshot, agent.id);
    if (!holdsReach(reach)) return [];
    const names = namesOf(agent, input);
    const active = input.events.some(
      (event) => Date.parse(event.at) >= cutoff && names.has(flat(event.agent)),
    );
    return active ? [] : [{ agentId: agent.id, kind: agent.kind, reach, knownSince }];
  });
}

/** What one agent holds in a snapshot, whether or not it has used any of it. */
export function agentReachOf(snapshot: EnvironmentSnapshot, agentId: string): AgentReach {
  const agent = snapshot.agents.find((each) => each.id === agentId);
  return {
    writeServers: snapshot.servers
      .filter(
        (server) =>
          server.agentIds.includes(agentId) &&
          server.tools.some((tool) => WRITE_EFFECTS.includes(tool.effect)),
      )
      .map((server) => server.name),
    credentials: snapshot.resources.filter(
      (resource) =>
        resource.sensitivity !== SENSITIVITY.ORDINARY &&
        resource.reachableBy.includes(agentId),
    ).length,
    hooks: agent === undefined || agent.harness === undefined ? [] : agent.harness.hooks,
  };
}

export function holdsReach(reach: AgentReach): boolean {
  return reach.writeServers.length > 0 || reach.credentials > 0 || reach.hooks.length > 0;
}

/** "2 servers with write tools (github, slack), 3 credentials", in the order people fear them. */
export function describeReach(reach: AgentReach): string {
  const parts: string[] = [];
  if (reach.writeServers.length > 0) {
    const servers = reach.writeServers.length === 1 ? 'server' : 'servers';
    parts.push(
      `${reach.writeServers.length} ${servers} with write tools (${reach.writeServers.join(', ')})`,
    );
  }
  if (reach.credentials > 0) {
    parts.push(`${reach.credentials} credential${reach.credentials === 1 ? '' : 's'}`);
  }
  if (reach.hooks.length > 0) parts.push(`hooks in ${reach.hooks.join(', ')}`);
  return parts.join(', ');
}

/**
 * Every name a ledger row may carry for this agent. A proxied call names only its server,
 * so it counts for every agent holding that server: never calling an agent dormant wrongly.
 */
function namesOf(agent: SnapshotAgent, input: DormancyInput): Set<string> {
  const aliases = input.aliases === undefined ? [] : (input.aliases[agent.id] ?? []);
  const servers = input.snapshot.servers
    .filter((server) => server.agentIds.includes(agent.id))
    .map((server) => `${PROXY_AGENT_PREFIX}${server.name}`);
  return new Set(
    [agent.id, agentNameIn(agent.id), agent.kind, ...aliases, ...servers].map(flat),
  );
}

/** Case and spacing are not identity, the same as `resolveAgent` reads a name. */
function flat(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}
