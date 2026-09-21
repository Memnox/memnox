/** Maps a `MemnoxEvent` to the flat `events` row it is stored as, and back. */
import { DECISION_EFFECT } from '../constants/decision.constants';
import { ENFORCEMENT_MODE } from '../constants/enforcement.constants';
import { TOOL_EFFECT } from '../discovery/discovery.constants';
import { ACTOR_TYPE, EVENT_SURFACE, type EventRuleRef, type MemnoxEvent } from './event';

export interface EventRow {
  [column: string]: string | number | null;
}

/** A rule read back without a layer came from the only layer every machine has. */
const DEFAULT_RULE_LAYER = 'project';

/** Joined rather than a second table, because the ids are always read back whole. */
const CONDITION_SEPARATOR = ',';

export function eventToRow(event: MemnoxEvent): EventRow {
  return {
    id: event.id,
    schemaVersion: event.schemaVersion,
    at: event.at,
    sessionId: event.sessionId,
    agent: event.agent,
    actorType: event.actorType,
    principal: event.principal ?? null,
    surface: event.surface,
    operation: event.operation,
    target: event.target ?? null,
    class: event.class,
    effect: event.effect,
    shadowEffect: event.shadowEffect ?? null,
    mode: event.mode,
    reason: event.reason,
    ...ruleColumns(event),
    policyHash: event.policyHash ?? null,
    bundleHash: event.bundleHash ?? null,
    conditionsInForce:
      event.conditionsInForce === undefined || event.conditionsInForce.length === 0
        ? null
        : event.conditionsInForce.join(CONDITION_SEPARATOR),
    argsDigest: event.argsDigest ?? null,
    execution: event.execution ?? null,
    exitCode: event.exitCode ?? null,
    durationMs: event.durationMs ?? null,
    outputDigest: event.outputDigest ?? null,
    authorizedBy: event.authorizedBy ?? null,
    costUsd: event.costUsd ?? null,
  };
}

function ruleColumns(event: MemnoxEvent): EventRow {
  const { rule, alternative } = event;
  return {
    ruleName: rule?.name ?? null,
    ruleLayer: rule?.layer ?? null,
    ruleFile: rule?.file ?? null,
    ruleLine: rule?.line ?? null,
    altAction: alternative?.action ?? null,
    altResource: alternative?.resource ?? null,
    altNote: alternative?.note ?? null,
  };
}

export function rowToEvent(row: EventRow): MemnoxEvent {
  const event = requiredFields(row);
  copyOptionalFields(row, event);
  const rule = ruleOf(row);
  if (rule !== undefined) event.rule = rule;
  const alternative = alternativeOf(row);
  if (alternative !== undefined) event.alternative = alternative;
  return event;
}

// The casts trust the row because only `eventToRow` ever wrote it.
function requiredFields(row: EventRow): MemnoxEvent {
  return {
    id: String(row['id']),
    schemaVersion: Number(row['schemaVersion']),
    at: String(row['at']),
    sessionId: String(row['sessionId']),
    agent: String(row['agent']),
    actorType: String(row['actorType']) as MemnoxEvent['actorType'],
    surface: String(row['surface']) as MemnoxEvent['surface'],
    operation: String(row['operation']),
    class: String(row['class']) as MemnoxEvent['class'],
    effect: String(row['effect']) as MemnoxEvent['effect'],
    mode: String(row['mode']) as MemnoxEvent['mode'],
    reason: String(row['reason']),
  };
}

const OPTIONAL_TEXT = [
  'principal',
  'target',
  'shadowEffect',
  'policyHash',
  'bundleHash',
  'argsDigest',
  'execution',
  'outputDigest',
  'authorizedBy',
] as const satisfies readonly (keyof MemnoxEvent)[];

const OPTIONAL_NUMBERS = ['exitCode', 'durationMs', 'costUsd'] as const;

function copyOptionalFields(row: EventRow, event: MemnoxEvent): void {
  for (const key of OPTIONAL_TEXT) {
    const value = textOf(row, key);
    if (value !== undefined) Object.assign(event, { [key]: value });
  }
  for (const key of OPTIONAL_NUMBERS) {
    const value = numberOf(row, key);
    if (value !== undefined) event[key] = value;
  }
  const conditions = textOf(row, 'conditionsInForce');
  if (conditions !== undefined)
    event.conditionsInForce = conditions.split(CONDITION_SEPARATOR);
}

function ruleOf(row: EventRow): EventRuleRef | undefined {
  const name = textOf(row, 'ruleName');
  if (name === undefined) return undefined;
  const line = numberOf(row, 'ruleLine');
  return {
    name,
    layer: textOf(row, 'ruleLayer') ?? DEFAULT_RULE_LAYER,
    file: textOf(row, 'ruleFile') ?? '',
    ...(line === undefined ? {} : { line }),
  };
}

function alternativeOf(row: EventRow): MemnoxEvent['alternative'] {
  const action = textOf(row, 'altAction');
  if (action === undefined) return undefined;
  const resource = textOf(row, 'altResource');
  return {
    action,
    note: textOf(row, 'altNote') ?? '',
    ...(resource === undefined ? {} : { resource }),
  };
}

function textOf(row: EventRow, key: string): string | undefined {
  const value = row[key];
  return value === null || value === undefined ? undefined : String(value);
}

function numberOf(row: EventRow, key: string): number | undefined {
  const value = row[key];
  return value === null || value === undefined ? undefined : Number(value);
}

/** Every column an insert names, taken from the row shape so the two cannot drift. */
export const EVENT_COLUMNS = Object.keys(
  eventToRow({
    id: '',
    schemaVersion: 1,
    at: '',
    sessionId: '',
    agent: '',
    actorType: ACTOR_TYPE.AGENT,
    surface: EVENT_SURFACE.MCP,
    operation: '',
    class: TOOL_EFFECT.READ,
    effect: DECISION_EFFECT.ALLOW,
    mode: ENFORCEMENT_MODE.OBSERVE,
    reason: '',
  }),
);
