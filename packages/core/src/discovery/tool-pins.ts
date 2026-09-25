/**
 * The tools each server answered with last time, kept on disk, so a server that grows a
 * deploy tool between two sessions is caught the moment it lists it rather than at the
 * next foreground scan. The daemon never starts a server; the proxy already talks to it.
 */
import { join } from 'node:path';

import { MEMNOX_HOME } from '../config/config';
import {
  ACTOR_TYPE,
  EVENT_SCHEMA_VERSION,
  EVENT_SURFACE,
  type MemnoxEvent,
} from '../event/event';
import { newEventId } from '../event/seam-row';
import { DECISION_EFFECT } from '../constants/decision.constants';
import type { EnforcementMode } from '../constants/enforcement.constants';
import { readJsonFile, writeJsonFile } from '../store/json-records';
import {
  changesExternalState,
  classifyTool,
  TOOL_CLASS,
  type ToolClass,
} from './classify';
import type { McpToolDeclaration } from './surface';

export const PINS_DIR = 'pins';

/** The row a tool arriving on a running server is recorded under. */
export const TOOL_ARRIVED_OPERATION = 'config.drift.new-write-tool';

export interface PinnedTool {
  name: string;
  class: ToolClass;
}

export interface ToolListChange {
  /** No pin existed, so this listing became it and nothing is compared. */
  first: boolean;
  added: PinnedTool[];
  removed: string[];
}

export interface ToolPins {
  compare(server: string, tools: readonly McpToolDeclaration[]): Promise<ToolListChange>;
}

export function pinnedFrom(tools: readonly McpToolDeclaration[]): PinnedTool[] {
  return tools
    .filter((tool) => tool.name !== '')
    .map((tool) => ({ name: tool.name, class: classifyTool(tool).class }));
}

/** What moved between two listings, by name and by what each tool does. */
export function changeBetween(
  before: readonly PinnedTool[] | null,
  after: readonly PinnedTool[],
): ToolListChange {
  if (before === null) return { first: true, added: [], removed: [] };
  const known = new Map(before.map((tool) => [tool.name, tool.class]));
  // A tool that kept its name and started to write is as new as one that arrived.
  const added = after.filter((tool) => {
    const was = known.get(tool.name);
    return (
      was === undefined ||
      (!changesExternalState(was) && changesExternalState(tool.class))
    );
  });
  const now = new Set(after.map((tool) => tool.name));
  const removed = before.filter((tool) => !now.has(tool.name)).map((tool) => tool.name);
  return { first: false, added, removed };
}

export class FileToolPins implements ToolPins {
  constructor(private readonly home: string) {}

  async compare(
    server: string,
    tools: readonly McpToolDeclaration[],
  ): Promise<ToolListChange> {
    const path = join(
      this.home,
      MEMNOX_HOME,
      PINS_DIR,
      `${server.replace(/[^\w.-]/g, '_')}.json`,
    );
    const before = await readJsonFile<PinnedTool[]>(path);
    const after = pinnedFrom(tools);
    await writeJsonFile(path, after);
    return changeBetween(Array.isArray(before) ? before : null, after);
  }
}

/** The tools in a change that can reach outside this machine, which are the ones to hear of. */
export function changingTools(change: ToolListChange): PinnedTool[] {
  return change.added.filter((tool) => changesExternalState(tool.class));
}

export interface ToolArrivalRow {
  server: string;
  tools: readonly PinnedTool[];
  /** Of those, the ones no rule covers, which is the part a person has to act on. */
  unruled: readonly string[];
  sessionId: string;
  agent: string;
  at: string;
  mode: EnforcementMode;
}

export function toolArrivalEvent(input: ToolArrivalRow): MemnoxEvent {
  const names = input.tools.map((tool) => tool.name).join(', ');
  const cover =
    input.unruled.length === 0
      ? 'a rule covers each of them'
      : `no rule covers ${input.unruled.join(', ')}`;
  return {
    id: newEventId(),
    schemaVersion: EVENT_SCHEMA_VERSION,
    at: input.at,
    sessionId: input.sessionId,
    agent: input.agent,
    actorType: ACTOR_TYPE.AUTOMATION,
    surface: EVENT_SURFACE.CONFIG,
    operation: TOOL_ARRIVED_OPERATION,
    target: input.server,
    class: TOOL_CLASS.READ,
    effect: DECISION_EFFECT.ALLOW,
    mode: input.mode,
    reason: `${input.server} listed ${names}, which it did not before and which change something outside this machine; ${cover}`,
  };
}

/** The row a wrapped server stopping under a working agent is recorded under. */
export const SERVER_DOWN_OPERATION = 'config.drift.server-down';

export interface ServerDownRow {
  server: string;
  exitCode: number;
  sessionId: string;
  agent: string;
  at: string;
  mode: EnforcementMode;
}

export function serverDownEvent(input: ServerDownRow): MemnoxEvent {
  return {
    id: newEventId(),
    schemaVersion: EVENT_SCHEMA_VERSION,
    at: input.at,
    sessionId: input.sessionId,
    agent: input.agent,
    actorType: ACTOR_TYPE.AUTOMATION,
    surface: EVENT_SURFACE.CONFIG,
    operation: SERVER_DOWN_OPERATION,
    target: input.server,
    class: TOOL_CLASS.READ,
    effect: DECISION_EFFECT.ALLOW,
    mode: input.mode,
    reason: `${input.server} stopped with exit code ${input.exitCode} while an agent was using it`,
    exitCode: input.exitCode,
  };
}
