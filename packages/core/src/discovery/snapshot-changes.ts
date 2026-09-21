import {
  CHANGE_DIRECTION,
  CHANGE_SUBJECT,
  SENSITIVITY,
  TOOL_EFFECT,
  type ChangeDirection,
  type ChangeSubject,
  type Sensitivity,
} from './discovery.constants';
import type {
  EnvironmentSnapshot,
  SnapshotAgent,
  SnapshotHarness,
  SnapshotResource,
  SnapshotServer,
  SnapshotTool,
} from './snapshot';

/**
 * One thing that moved between two scans, and which way, because a list mixing a new
 * credential with a removed one is a list nobody can act on.
 */
export interface EnvironmentChange {
  subject: ChangeSubject;
  name: string;
  direction: ChangeDirection;
  /** What actually changed, in the words the report would have used. */
  detail: string;
  /** How sensitive a resource is, so a gate reads a field rather than the wording. */
  sensitivity?: Sensitivity;
  /** The file that granted it, where a file granted it. */
  grantedBy?: string;
  /** Agents that reach it after the change. */
  agents?: string[];
  /** The update that explains it, so the common case reads as a change to approve. */
  cause?: string;
}

/** Agent id to the update that moved its version between the two scans. */
type Causes = ReadonlyMap<string, string>;

/** What moved, in both directions, arrivals first: a new capability is why anybody runs this. */
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

function updateCauses(before: EnvironmentSnapshot, after: EnvironmentSnapshot): Causes {
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

/**
 * Agent software updates itself and none of that arrives as an event, so a version that
 * moved is named as the cause of what moved with it.
 */
function updateBetween(before: SnapshotAgent, after: SnapshotAgent): string | undefined {
  if (before.version === undefined || after.version === undefined) return undefined;
  if (before.version === after.version) return undefined;
  return `updated ${before.version} → ${after.version}`;
}

/** The update that explains a change, where exactly one updated agent reaches it. */
function causeOf(causes: Causes, agentIds: readonly string[]): { cause?: string } {
  const named = [...new Set(agentIds.map((id) => causes.get(id)))].filter(
    (cause): cause is string => cause !== undefined,
  );
  const [only] = named;
  return named.length === 1 && only !== undefined ? { cause: only } : {};
}

function serverChanges(
  before: EnvironmentSnapshot,
  after: EnvironmentSnapshot,
  causes: Causes,
): EnvironmentChange[] {
  const priorByName = new Map(before.servers.map((server) => [server.name, server]));
  const currentNames = new Set(after.servers.map((server) => server.name));
  return [
    ...after.servers.flatMap((server) =>
      serverArrival(server, priorByName.get(server.name), causes),
    ),
    ...before.servers
      .filter((server) => !currentNames.has(server.name))
      .map((server) => ({
        subject: CHANGE_SUBJECT.SERVER,
        name: server.name,
        direction: CHANGE_DIRECTION.NARROWS,
        detail: 'removed',
        grantedBy: server.grantedBy,
      })),
  ];
}

/** A new server, or new tools on one already there. */
function serverArrival(
  server: SnapshotServer,
  prior: SnapshotServer | undefined,
  causes: Causes,
): EnvironmentChange[] {
  const arrival = (subject: ChangeSubject, detail: string): EnvironmentChange => ({
    subject,
    name: server.name,
    direction: CHANGE_DIRECTION.WIDENS,
    detail,
    grantedBy: server.grantedBy,
    agents: server.agentIds,
    ...causeOf(causes, server.agentIds),
  });
  if (prior === undefined)
    return [arrival(CHANGE_SUBJECT.SERVER, describeTools(server.tools))];
  const arrived = server.tools.filter(
    (tool) => !prior.tools.some((each) => each.name === tool.name),
  );
  if (arrived.length === 0) return [];
  const names = arrived.map((tool) => tool.name).join(', ');
  return [arrival(CHANGE_SUBJECT.TOOL, `${describeTools(arrived)}: ${names}`)];
}

function resourceChanges(
  before: EnvironmentSnapshot,
  after: EnvironmentSnapshot,
  causes: Causes,
): EnvironmentChange[] {
  const priorById = new Map(before.resources.map((resource) => [resource.id, resource]));
  const currentIds = new Set(after.resources.map((resource) => resource.id));
  return [
    ...after.resources.flatMap((resource) =>
      reachChange(resource, priorById.get(resource.id), causes),
    ),
    ...before.resources
      .filter(
        (resource) => !currentIds.has(resource.id) && resource.reachableBy.length > 0,
      )
      .map((resource) => ({
        subject: CHANGE_SUBJECT.RESOURCE,
        name: resource.path ?? resource.id,
        direction: CHANGE_DIRECTION.NARROWS,
        detail: 'no longer present',
      })),
  ];
}

/**
 * A new reachable resource, or one more or fewer agents reach. A file nothing reached
 * yesterday and three agents reach today never shows up as a new path.
 */
function reachChange(
  resource: SnapshotResource,
  prior: SnapshotResource | undefined,
  causes: Causes,
): EnvironmentChange[] {
  const name = resource.path ?? resource.id;
  const reach = resource.reachableBy.length;
  const was = prior?.reachableBy.length ?? 0;
  const widened = (detail: string): EnvironmentChange => ({
    subject: CHANGE_SUBJECT.RESOURCE,
    name,
    direction: CHANGE_DIRECTION.WIDENS,
    detail,
    sensitivity: resource.sensitivity,
    agents: resource.reachableBy,
    ...causeOf(causes, resource.reachableBy),
  });
  if (prior === undefined) {
    return reach === 0 ? [] : [widened(describeReach(resource.sensitivity, reach))];
  }
  if (reach > was) return [widened(`${was} → ${reach} agents`)];
  if (reach === was) return [];
  return [
    {
      subject: CHANGE_SUBJECT.RESOURCE,
      name,
      direction: CHANGE_DIRECTION.NARROWS,
      detail: `${was} → ${reach} agents`,
      agents: resource.reachableBy,
    },
  ];
}

function surfaceChanges(
  before: EnvironmentSnapshot,
  after: EnvironmentSnapshot,
  causes: Causes,
): EnvironmentChange[] {
  const priorById = new Map(before.agents.map((agent) => [agent.id, agent]));
  const currentIds = new Set(after.agents.map((agent) => agent.id));
  return [
    ...after.agents.flatMap((agent) => {
      const prior = priorById.get(agent.id);
      return prior === undefined
        ? [newAgent(agent)]
        : surfacesMoved(agent, prior, causes.get(agent.id));
    }),
    ...before.agents
      .filter((agent) => !currentIds.has(agent.id))
      .map((agent) => ({
        subject: CHANGE_SUBJECT.AGENT,
        name: agent.kind,
        direction: CHANGE_DIRECTION.NARROWS,
        detail: 'no longer installed',
      })),
  ];
}

function newAgent(agent: SnapshotAgent): EnvironmentChange {
  const count = agent.surfaces.length;
  return {
    subject: CHANGE_SUBJECT.AGENT,
    name: agent.kind,
    direction: CHANGE_DIRECTION.WIDENS,
    detail: `${count} surface${count === 1 ? '' : 's'}`,
  };
}

/** Surface kinds an agent gained and lost between the two scans. */
function surfacesMoved(
  agent: SnapshotAgent,
  prior: SnapshotAgent,
  cause: string | undefined,
): EnvironmentChange[] {
  const gained = agent.surfaces.filter(
    (surface) => !prior.surfaces.some((each) => each.kind === surface.kind),
  );
  const lost = prior.surfaces.filter(
    (surface) => !agent.surfaces.some((each) => each.kind === surface.kind),
  );
  return [
    ...gained.map((surface) => ({
      subject: CHANGE_SUBJECT.SURFACE,
      name: `${agent.kind} · ${surface.kind}`,
      direction: CHANGE_DIRECTION.WIDENS,
      detail: 'new surface',
      grantedBy: surface.detectedFrom,
      ...(cause === undefined ? {} : { cause }),
    })),
    ...lost.map((surface) => ({
      subject: CHANGE_SUBJECT.SURFACE,
      name: `${agent.kind} · ${surface.kind}`,
      direction: CHANGE_DIRECTION.NARROWS,
      detail: 'gone',
    })),
  ];
}

/**
 * A role, a hook file or a federation link arriving under something that runs other
 * agents, which moves the principal count while the harness's own surfaces stay put.
 */
function harnessChanges(
  before: EnvironmentSnapshot,
  after: EnvironmentSnapshot,
): EnvironmentChange[] {
  const priorById = new Map(before.agents.map((agent) => [agent.id, agent]));
  return after.agents.flatMap((agent) => {
    const was = priorById.get(agent.id)?.harness;
    // A harness that was not there before is already reported as a new agent.
    if (agent.harness === undefined || was === undefined) return [];
    return harnessMoved(agent, agent.harness, was);
  });
}

function harnessMoved(
  agent: SnapshotAgent,
  now: SnapshotHarness,
  was: SnapshotHarness,
): EnvironmentChange[] {
  const widened = (detail: string): EnvironmentChange => ({
    subject: CHANGE_SUBJECT.HARNESS,
    name: agent.kind,
    direction: CHANGE_DIRECTION.WIDENS,
    detail,
    agents: [agent.id],
  });
  const changes: EnvironmentChange[] = [];
  for (const [what, arrived] of [
    ['role', newIn(now.roles, was.roles)],
    ['hook file', newIn(now.hooks, was.hooks)],
    ['runtime', newIn(now.runtimes, was.runtimes)],
  ] as const) {
    if (arrived.length === 0) continue;
    const plural = arrived.length === 1 ? '' : 's';
    changes.push(
      widened(`${arrived.length} new ${what}${plural}: ${arrived.join(', ')}`),
    );
  }
  if (now.federated && !was.federated) {
    changes.push(
      widened('now works with agents on other machines, which this scan cannot see'),
    );
  }
  const gone = newIn(was.roles, now.roles);
  if (gone.length > 0) {
    changes.push({
      subject: CHANGE_SUBJECT.HARNESS,
      name: agent.kind,
      direction: CHANGE_DIRECTION.NARROWS,
      detail: `${gone.length} role${gone.length === 1 ? '' : 's'} gone: ${gone.join(', ')}`,
    });
  }
  return changes;
}

function newIn(now: readonly string[], was: readonly string[]): string[] {
  return now.filter((each) => !was.includes(each));
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

/** "14 tools · 5 write · 1 destructive", which is the only version of the count anybody acts on. */
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
