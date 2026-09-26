/**
 * One session added up from the ledger: which files it read and changed, what it read and
 * changed in each system outside this machine, and what was stopped. Counts, never a score.
 */
import { DECISION_EFFECT } from '../constants/decision.constants';
import { changesExternalState, TOOL_CLASS } from '../discovery/classify';
import { ACTOR_TYPE, type MemnoxEvent } from '../event/event';
import { EXECUTION } from '../event/event';

/** The few refusals named, because a list nobody scrolls is one nobody reads to the end. */
const BLOCKED_SHOWN = 5;

export interface SystemTouched {
  /** `gh`, `railway`, a host, or an MCP server by its name. */
  name: string;
  reads: number;
  changes: number;
}

export interface BlockedAction {
  operation: string;
  target?: string;
  reason: string;
}

export interface SessionSummary {
  sessionId: string;
  agent: string;
  started: string;
  ended: string;
  actions: number;
  /** Distinct files, so reading one file ten times is one file read. */
  filesRead: number;
  filesChanged: number;
  systems: SystemTouched[];
  blocked: BlockedAction[];
  blockedCount: number;
  /** Put to a person, whatever they answered. */
  held: number;
  /** Allowed by a person who was asked. */
  approved: number;
  /** Changes that ran outside this machine, over every system. Zero is the line people read. */
  outsideChanges: number;
}

const FILE_NAMESPACES = ['file', 'filesystem'];
/** Local work rather than a system anybody else sees. */
const LOCAL_NAMESPACES = ['shell', 'process', 'package', 'config', 'question'];

/** Which system an action touched, or null for a file or local work. */
export function systemOf(
  event: Pick<MemnoxEvent, 'operation' | 'target'>,
): string | null {
  const [namespace, second] = event.operation.split('.');
  if (namespace === undefined || FILE_NAMESPACES.includes(namespace)) return null;
  if (LOCAL_NAMESPACES.includes(namespace)) return null;
  // `mcp.<server>.<tool>` names its server; `mcp.<tool>` carries it as the target.
  if (namespace === 'mcp') {
    const parts = event.operation.split('.');
    return parts.length > 2
      ? `${second} (MCP)`
      : `${event.target ?? 'an MCP server'} (MCP)`;
  }
  if (namespace === 'http' || namespace === 'network')
    return event.target ?? 'the network';
  return namespace;
}

function wasBlocked(event: MemnoxEvent): boolean {
  return event.effect === DECISION_EFFECT.DENY || event.execution === EXECUTION.BLOCKED;
}

function isChange(event: MemnoxEvent): boolean {
  return changesExternalState(event.class);
}

export function summarizeSession(events: readonly MemnoxEvent[]): SessionSummary | null {
  const ordered = [...events].sort((a, b) => a.at.localeCompare(b.at));
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  if (first === undefined || last === undefined) return null;

  const ran = ordered.filter((event) => !wasBlocked(event));
  const blocked = ordered.filter(wasBlocked);
  return {
    sessionId: first.sessionId,
    agent: first.agent,
    started: first.at,
    ended: last.at,
    actions: ordered.length,
    ...filesOf(ran),
    systems: systemsOf(ran),
    blocked: blocked.slice(0, BLOCKED_SHOWN).map((event) => ({
      operation: event.operation,
      ...(event.target === undefined ? {} : { target: event.target }),
      reason: event.reason,
    })),
    blockedCount: blocked.length,
    held: ordered.filter((event) => event.effect === DECISION_EFFECT.ASK).length,
    approved: ordered.filter(
      (event) =>
        event.actorType === ACTOR_TYPE.HUMAN && event.effect === DECISION_EFFECT.ALLOW,
    ).length,
    outsideChanges: systemsOf(ran).reduce((total, each) => total + each.changes, 0),
  };
}

function filesOf(ran: readonly MemnoxEvent[]): {
  filesRead: number;
  filesChanged: number;
} {
  const read = new Set<string>();
  const changed = new Set<string>();
  for (const event of ran) {
    const namespace = event.operation.split('.')[0] ?? '';
    if (!FILE_NAMESPACES.includes(namespace) || event.target === undefined) continue;
    if (event.class === TOOL_CLASS.READ) read.add(event.target);
    else if (isChange(event)) changed.add(event.target);
  }
  return { filesRead: read.size, filesChanged: changed.size };
}

/** Busiest first, so the system an agent lived in heads the list. */
function systemsOf(ran: readonly MemnoxEvent[]): SystemTouched[] {
  const systems = new Map<string, SystemTouched>();
  for (const event of ran) {
    const name = systemOf(event);
    if (name === null) continue;
    const system = systems.get(name) ?? { name, reads: 0, changes: 0 };
    if (event.class === TOOL_CLASS.READ) system.reads += 1;
    else if (isChange(event)) system.changes += 1;
    systems.set(name, system);
  }
  return [...systems.values()].sort(
    (a, b) => b.reads + b.changes - (a.reads + a.changes) || a.name.localeCompare(b.name),
  );
}

/** The systems named in a line, by name; the rest are counted. */
const SYSTEMS_IN_LINE = 3;

/** One line for the end of a run, when the rail has closed and the terminal is the agent's. */
export function describeSummary(summary: SessionSummary): string {
  const systems = summary.systems
    .slice(0, SYSTEMS_IN_LINE)
    .map((each) => `${each.name} ${each.reads} read, ${each.changes} changed`);
  const more = summary.systems.length - SYSTEMS_IN_LINE;
  const parts = [
    `${summary.actions} action(s)`,
    `${summary.filesRead} file(s) read, ${summary.filesChanged} changed`,
    ...systems,
    ...(more > 0 ? [`${more} more system(s)`] : []),
    ...(summary.blockedCount > 0 ? [`${summary.blockedCount} stopped`] : []),
    ...(summary.approved > 0 ? [`${summary.approved} approved`] : []),
    `${summary.outsideChanges} change(s) outside this machine`,
  ];
  return `session ${summary.sessionId}: ${parts.join('; ')}. memnox report --session ${summary.sessionId}`;
}
