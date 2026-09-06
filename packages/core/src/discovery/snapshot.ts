import type { DiscoveryReport } from './discover';
import type { Surface } from './surface';
import {
  CHANGE_DIRECTION,
  CHANGE_SUBJECT,
  EFFECT_INFERENCE,
  SENSITIVITY,
  SURFACE_KIND,
  TOOL_EFFECT,
  type ChangeDirection,
  type ChangeSubject,
  type ResourceKind,
  type Sensitivity,
  type SurfaceKind,
  type ToolEffect,
} from './discovery.constants';

/**
 * What the machine held at one moment, reduced to the fields a later comparison can
 * read. Never the whole report: a snapshot is kept for weeks, so it carries names,
 * counts and fingerprints and nothing that was inside a file.
 */
export interface EnvironmentSnapshot {
  takenAt: string;
  agents: SnapshotAgent[];
  servers: SnapshotServer[];
  resources: SnapshotResource[];
}

export interface SnapshotAgent {
  id: string;
  kind: string;
  /** So an update is named as the cause of what it changed, rather than raised as an alarm. */
  version?: string;
  /** One entry per surface kind, so a widened surface is a comparison and not a guess. */
  surfaces: SnapshotSurface[];
  /**
   * Present only for a harness. A role that appeared overnight is the drift a
   * per-agent roster cannot see, so the membership is kept rather than the count.
   */
  harness?: SnapshotHarness;
}

export interface SnapshotHarness {
  runtimes: string[];
  roles: string[];
  hooks: string[];
  federated: boolean;
}

export interface SnapshotSurface {
  kind: SurfaceKind;
  /** The file that proved it, which is the answer to "who granted this". */
  detectedFrom: string;
}

export interface SnapshotServer {
  name: string;
  /** The config file that launches it. Provenance for authority, not just for code. */
  grantedBy: string;
  agentIds: string[];
  tools: SnapshotTool[];
}

export interface SnapshotTool {
  name: string;
  effect: ToolEffect;
}

export interface SnapshotResource {
  id: string;
  kind: ResourceKind;
  /** Absent for a resource that is not a file — the network, or a database URL. */
  path?: string;
  sensitivity: Sensitivity;
  reachableBy: string[];
}

/** Reduces a report to what survives being kept. Pure: the clock is an argument. */
export function snapshotOf(
  report: DiscoveryReport,
  takenAt: string,
): EnvironmentSnapshot {
  return {
    takenAt,
    agents: report.agents.map((agent) => {
      const harness = report.harnesses.find((each) => each.agentId === agent.id);
      return {
        id: agent.id,
        kind: agent.kind,
        ...(agent.version === undefined ? {} : { version: agent.version }),
        surfaces: report.surfaces
          .filter((surface) => surface.agentId === agent.id)
          .map((surface) => ({
            kind: surface.kind,
            detectedFrom: surface.detectedFrom,
          })),
        ...(harness === undefined
          ? {}
          : {
              harness: {
                runtimes: [...harness.runtimes],
                roles: [...harness.roles],
                hooks: [...harness.hooks],
                federated: harness.federated,
              },
            }),
      };
    }),
    servers: serversIn(report),
    resources: report.resources.map((resource) => ({
      id: resource.id,
      kind: resource.kind,
      ...(resource.path === undefined ? {} : { path: resource.path }),
      sensitivity: resource.sensitivity,
      reachableBy: resource.reachableBy.map((ref) => ref.id),
    })),
  };
}

/** One row per server, whichever agents launch it, with the config that named it. */
function serversIn(report: DiscoveryReport): SnapshotServer[] {
  const byName = new Map<string, SnapshotServer>();

  for (const surface of report.surfaces) {
    if (surface.kind !== SURFACE_KIND.MCP) continue;
    for (const launch of surface.servers ?? []) {
      const existing = byName.get(launch.name);
      if (existing === undefined) {
        byName.set(launch.name, {
          name: launch.name,
          grantedBy: surface.detectedFrom,
          agentIds: [surface.agentId],
          tools: [],
        });
        continue;
      }
      if (!existing.agentIds.includes(surface.agentId)) {
        existing.agentIds.push(surface.agentId);
      }
    }
    for (const tool of surface.tools ?? []) {
      const server = byName.get(tool.server);
      if (server === undefined) continue;
      if (server.tools.some((each) => each.name === tool.name)) continue;
      server.tools.push({ name: tool.name, effect: tool.effect });
    }
  }
  return [...byName.values()];
}

/**
 * The tools a probed scan found, put back onto the surfaces of an unprobed one.
 *
 * Only `scan` starts MCP servers; `doctor` and `protect` deliberately do not, and
 * without this every finding that depends on knowing a tool exists is unreachable
 * from those two commands however true it is. A snapshot is the record of the last
 * time somebody did ask, so it is what they read instead of asking again.
 */
export function withToolsFrom(
  surfaces: readonly Surface[],
  snapshot: EnvironmentSnapshot | null,
): Surface[] {
  if (snapshot === null) return [...surfaces];
  return surfaces.map((surface) => {
    if ((surface.tools ?? []).length > 0) return surface;
    const names = new Set((surface.servers ?? []).map((server) => server.name));
    if (names.size === 0) return surface;
    const tools = snapshot.servers
      .filter(
        (server) => names.has(server.name) && server.agentIds.includes(surface.agentId),
      )
      .flatMap((server) =>
        server.tools.map((tool) => ({
          server: server.name,
          name: tool.name,
          effect: tool.effect,
          // Read back from a record rather than inferred here, and it says so.
          inferredFrom: EFFECT_INFERENCE.PROBE,
        })),
      );
    return tools.length === 0 ? surface : { ...surface, tools };
  });
}

/** The newest snapshot that actually enumerated tools, or null when none ever did. */
export function lastProbed(
  history: readonly EnvironmentSnapshot[],
): EnvironmentSnapshot | null {
  for (let at = history.length - 1; at >= 0; at -= 1) {
    const snapshot = history[at] as EnvironmentSnapshot;
    if (snapshot.servers.some((server) => server.tools.length > 0)) return snapshot;
  }
  return null;
}

/**
 * One thing that moved between two scans. A change says which way it moved, because
 * a list that mixes a new credential with a removed one is a list nobody can act on.
 */
export interface EnvironmentChange {
  subject: ChangeSubject;
  name: string;
  direction: ChangeDirection;
  /** What actually changed, in the words the report would have used. */
  detail: string;
  /** The file that granted it, where a file granted it. */
  grantedBy?: string;
  /** Agents that reach it after the change. */
  agents?: string[];
  /**
   * A widened agent is usually somebody installing something, not an attack. Naming
   * the cause makes the common case a change to approve, so the rare one stands out.
   */
  cause?: string;
}

/**
 * What moved, in both directions, with the cause where the cause is knowable. Order
 * is arrivals first: a new capability is the reason anybody runs this.
 */
export function compareSnapshots(
  before: EnvironmentSnapshot,
  after: EnvironmentSnapshot,
): EnvironmentChange[] {
  const causes = updateCauses(before, after);
  return [
    ...serverChanges(before, after, causes),
    ...resourceChanges(before, after, causes),
    ...surfaceChanges(before, after, causes),
    ...harnessChanges(before, after),
  ];
}

/** One entry per agent whose own version moved between the two scans. */
function updateCauses(
  before: EnvironmentSnapshot,
  after: EnvironmentSnapshot,
): Map<string, string> {
  const priorById = new Map(before.agents.map((agent) => [agent.id, agent]));
  const causes = new Map<string, string>();
  for (const agent of after.agents) {
    const prior = priorById.get(agent.id);
    if (prior === undefined) continue;
    const cause = updateBetween(prior, agent);
    if (cause !== undefined) causes.set(agent.id, cause);
  }
  return causes;
}

/** The update that explains a change, where exactly one updated agent reaches it. */
function causeFor(
  causes: ReadonlyMap<string, string>,
  agentIds: readonly string[],
): string | undefined {
  const named = [...new Set(agentIds.map((id) => causes.get(id)))].filter(
    (cause): cause is string => cause !== undefined,
  );
  return named.length === 1 ? named[0] : undefined;
}

function serverChanges(
  before: EnvironmentSnapshot,
  after: EnvironmentSnapshot,
  causes: ReadonlyMap<string, string>,
): EnvironmentChange[] {
  const changes: EnvironmentChange[] = [];
  const priorByName = new Map(before.servers.map((server) => [server.name, server]));

  for (const server of after.servers) {
    const prior = priorByName.get(server.name);
    if (prior === undefined) {
      changes.push({
        subject: CHANGE_SUBJECT.SERVER,
        name: server.name,
        direction: CHANGE_DIRECTION.WIDENS,
        detail: describeTools(server.tools),
        grantedBy: server.grantedBy,
        agents: server.agentIds,
        ...causeOf(causes, server.agentIds),
      });
      continue;
    }
    const arrived = server.tools.filter(
      (tool) => !prior.tools.some((each) => each.name === tool.name),
    );
    if (arrived.length > 0) {
      changes.push({
        subject: CHANGE_SUBJECT.TOOL,
        name: server.name,
        direction: CHANGE_DIRECTION.WIDENS,
        detail: `${describeTools(arrived)}: ${arrived.map((tool) => tool.name).join(', ')}`,
        grantedBy: server.grantedBy,
        agents: server.agentIds,
        ...causeOf(causes, server.agentIds),
      });
    }
  }

  const currentNames = new Set(after.servers.map((server) => server.name));
  for (const server of before.servers) {
    if (currentNames.has(server.name)) continue;
    changes.push({
      subject: CHANGE_SUBJECT.SERVER,
      name: server.name,
      direction: CHANGE_DIRECTION.NARROWS,
      detail: 'removed',
      grantedBy: server.grantedBy,
    });
  }
  return changes;
}

function resourceChanges(
  before: EnvironmentSnapshot,
  after: EnvironmentSnapshot,
  causes: ReadonlyMap<string, string>,
): EnvironmentChange[] {
  const changes: EnvironmentChange[] = [];
  const priorById = new Map(before.resources.map((resource) => [resource.id, resource]));

  for (const resource of after.resources) {
    const prior = priorById.get(resource.id);
    const reach = resource.reachableBy.length;
    if (prior === undefined) {
      if (reach === 0) continue;
      changes.push({
        subject: CHANGE_SUBJECT.RESOURCE,
        name: resource.path ?? resource.id,
        direction: CHANGE_DIRECTION.WIDENS,
        detail: describeReach(resource.sensitivity, reach),
        agents: resource.reachableBy,
        ...causeOf(causes, resource.reachableBy),
      });
      continue;
    }
    // A file nothing could reach yesterday and three agents can reach today is the
    // change worth a line, and it never shows up as a new path.
    if (reach > prior.reachableBy.length) {
      changes.push({
        subject: CHANGE_SUBJECT.RESOURCE,
        name: resource.path ?? resource.id,
        direction: CHANGE_DIRECTION.WIDENS,
        detail: `${prior.reachableBy.length} → ${reach} agents`,
        agents: resource.reachableBy,
        ...causeOf(causes, resource.reachableBy),
      });
    } else if (reach < prior.reachableBy.length) {
      changes.push({
        subject: CHANGE_SUBJECT.RESOURCE,
        name: resource.path ?? resource.id,
        direction: CHANGE_DIRECTION.NARROWS,
        detail: `${prior.reachableBy.length} → ${reach} agents`,
        agents: resource.reachableBy,
      });
    }
  }

  const currentIds = new Set(after.resources.map((resource) => resource.id));
  for (const resource of before.resources) {
    if (currentIds.has(resource.id)) continue;
    if (resource.reachableBy.length === 0) continue;
    changes.push({
      subject: CHANGE_SUBJECT.RESOURCE,
      name: resource.path ?? resource.id,
      direction: CHANGE_DIRECTION.NARROWS,
      detail: 'no longer present',
    });
  }
  return changes;
}

function surfaceChanges(
  before: EnvironmentSnapshot,
  after: EnvironmentSnapshot,
  causes: ReadonlyMap<string, string>,
): EnvironmentChange[] {
  const changes: EnvironmentChange[] = [];
  const priorById = new Map(before.agents.map((agent) => [agent.id, agent]));

  for (const agent of after.agents) {
    const prior = priorById.get(agent.id);
    if (prior === undefined) {
      changes.push({
        subject: CHANGE_SUBJECT.AGENT,
        name: agent.kind,
        direction: CHANGE_DIRECTION.WIDENS,
        detail: `${agent.surfaces.length} surface${agent.surfaces.length === 1 ? '' : 's'}`,
      });
      continue;
    }
    const cause = causes.get(agent.id);
    for (const surface of agent.surfaces) {
      if (prior.surfaces.some((each) => each.kind === surface.kind)) continue;
      changes.push({
        subject: CHANGE_SUBJECT.SURFACE,
        name: `${agent.kind} · ${surface.kind}`,
        direction: CHANGE_DIRECTION.WIDENS,
        detail: 'new surface',
        grantedBy: surface.detectedFrom,
        ...(cause === undefined ? {} : { cause }),
      });
    }
    for (const surface of prior.surfaces) {
      if (agent.surfaces.some((each) => each.kind === surface.kind)) continue;
      changes.push({
        subject: CHANGE_SUBJECT.SURFACE,
        name: `${agent.kind} · ${surface.kind}`,
        direction: CHANGE_DIRECTION.NARROWS,
        detail: 'gone',
      });
    }
  }

  const currentIds = new Set(after.agents.map((agent) => agent.id));
  for (const agent of before.agents) {
    if (currentIds.has(agent.id)) continue;
    changes.push({
      subject: CHANGE_SUBJECT.AGENT,
      name: agent.kind,
      direction: CHANGE_DIRECTION.NARROWS,
      detail: 'no longer installed',
    });
  }
  return changes;
}

/**
 * A role, a hook file or a federation link arriving under something that runs other
 * agents. Reported separately from a surface because the harness's own surfaces do not
 * move when it gains a fifth role: the principal count does, and nothing else would say so.
 */
function harnessChanges(
  before: EnvironmentSnapshot,
  after: EnvironmentSnapshot,
): EnvironmentChange[] {
  const changes: EnvironmentChange[] = [];
  const priorById = new Map(before.agents.map((agent) => [agent.id, agent]));

  for (const agent of after.agents) {
    const now = agent.harness;
    if (now === undefined) continue;
    const was = priorById.get(agent.id)?.harness;
    // A harness that was not there before is already reported as a new agent.
    if (was === undefined) continue;

    for (const [what, arrived] of [
      ['role', now.roles.filter((role) => !was.roles.includes(role))],
      ['hook file', now.hooks.filter((hook) => !was.hooks.includes(hook))],
      ['runtime', now.runtimes.filter((runtime) => !was.runtimes.includes(runtime))],
    ] as const) {
      if (arrived.length === 0) continue;
      changes.push({
        subject: CHANGE_SUBJECT.HARNESS,
        name: agent.kind,
        direction: CHANGE_DIRECTION.WIDENS,
        detail: `${arrived.length} new ${what}${arrived.length === 1 ? '' : 's'}: ${arrived.join(', ')}`,
        agents: [agent.id],
      });
    }

    if (now.federated && !was.federated) {
      changes.push({
        subject: CHANGE_SUBJECT.HARNESS,
        name: agent.kind,
        direction: CHANGE_DIRECTION.WIDENS,
        detail: 'now works with agents on other machines, which this scan cannot see',
        agents: [agent.id],
      });
    }

    const gone = was.roles.filter((role) => !now.roles.includes(role));
    if (gone.length > 0) {
      changes.push({
        subject: CHANGE_SUBJECT.HARNESS,
        name: agent.kind,
        direction: CHANGE_DIRECTION.NARROWS,
        detail: `${gone.length} role${gone.length === 1 ? '' : 's'} gone: ${gone.join(', ')}`,
      });
    }
  }
  return changes;
}

function causeOf(
  causes: ReadonlyMap<string, string>,
  agentIds: readonly string[],
): { cause?: string } {
  const cause = causeFor(causes, agentIds);
  return cause === undefined ? {} : { cause };
}

/**
 * Agent software updates itself, and none of that arrives as an event anywhere. A
 * version that moved is the cause of what moved with it, and saying so turns the
 * common case into a change to approve rather than a threat to investigate.
 */
function updateBetween(before: SnapshotAgent, after: SnapshotAgent): string | undefined {
  if (before.version === undefined || after.version === undefined) return undefined;
  if (before.version === after.version) return undefined;
  return `updated ${before.version} → ${after.version}`;
}

/** Counts and names, never a percentage: the denominator here would be invented. */
export function summarizeChanges(changes: readonly EnvironmentChange[]): {
  widens: number;
  narrows: number;
} {
  return {
    widens: changes.filter((change) => change.direction === CHANGE_DIRECTION.WIDENS)
      .length,
    narrows: changes.filter((change) => change.direction === CHANGE_DIRECTION.NARROWS)
      .length,
  };
}

/** "14 tools · 5 write · 1 destructive" — the only version of the count anybody acts on. */
export function describeTools(tools: readonly SnapshotTool[]): string {
  const write = tools.filter((tool) => tool.effect === TOOL_EFFECT.WRITE).length;
  const destructive = tools.filter(
    (tool) => tool.effect === TOOL_EFFECT.DESTRUCTIVE,
  ).length;
  const parts = [`${tools.length} tool${tools.length === 1 ? '' : 's'}`];
  if (write > 0) parts.push(`${write} write`);
  if (destructive > 0) parts.push(`${destructive} destructive`);
  return parts.join(' · ');
}

function describeReach(sensitivity: Sensitivity, agents: number): string {
  const who = `${agents} agent${agents === 1 ? '' : 's'}`;
  return sensitivity === SENSITIVITY.ORDINARY ? who : `readable, ${who}`;
}
