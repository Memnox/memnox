/**
 * The event schema, frozen at v1. The cloud ingests against it, so a change is a new version
 * and never an edit; additive optional fields are the only safe change within a version.
 */
import {
  ACTOR_TYPE,
  EVENT_SCHEMA_VERSION,
  EVENT_SURFACE,
  EXECUTION,
  type MemnoxEvent,
} from './event';
import { DECISION_EFFECT } from '../constants/decision.constants';
import { ENFORCEMENT_MODE } from '../constants/enforcement.constants';
import { TOOL_CLASS } from '../discovery/classify';

/** Longer than any digest this writes, so anything past it is content that escaped. */
const LONGEST_FIELD = 128;

export const EVENT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://memnox.dev/schema/event-v1.json',
  title: 'MemnoxEvent',
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'schemaVersion',
    'at',
    'sessionId',
    'agent',
    'actorType',
    'surface',
    'operation',
    'class',
    'effect',
    'mode',
    'reason',
  ],
  properties: {
    id: { type: 'string', minLength: 1 },
    schemaVersion: { type: 'integer', const: EVENT_SCHEMA_VERSION },
    at: { type: 'string', format: 'date-time' },
    sessionId: { type: 'string', minLength: 1 },
    agent: { type: 'string', minLength: 1 },
    actorType: { enum: Object.values(ACTOR_TYPE) },
    principal: { type: 'string' },
    surface: { enum: Object.values(EVENT_SURFACE) },
    operation: { type: 'string', minLength: 1 },
    target: { type: 'string' },
    class: { enum: Object.values(TOOL_CLASS) },
    effect: { enum: Object.values(DECISION_EFFECT) },
    shadowEffect: { enum: Object.values(DECISION_EFFECT) },
    mode: { enum: Object.values(ENFORCEMENT_MODE) },
    reason: { type: 'string' },
    rule: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'layer', 'file'],
      properties: {
        name: { type: 'string' },
        layer: { type: 'string' },
        file: { type: 'string' },
        line: { type: 'integer', minimum: 1 },
      },
    },
    alternative: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string' },
        resource: { type: 'string' },
        note: { type: 'string' },
      },
    },
    policyHash: { type: 'string' },
    bundleHash: { type: 'string' },
    conditionsInForce: { type: 'array', items: { type: 'string' } },
    argsDigest: { type: 'string' },
    execution: { enum: Object.values(EXECUTION) },
    exitCode: { type: 'integer' },
    durationMs: { type: 'integer', minimum: 0 },
    // Additive and optional, which is the only safe change inside a frozen v1.
    costUsd: { type: 'number', minimum: 0 },
    outputDigest: { type: 'string' },
    authorizedBy: { type: 'string' },
  },
} as const;

/** Fields that may never carry content, only a hash of it. */
const DIGEST_FIELDS = ['argsDigest', 'outputDigest'] as const;

/**
 * Checked at the boundary rather than trusted. Returns every problem rather than the
 * first, because a caller fixing one field at a time round-trips forever.
 */
export function validateEvent(candidate: unknown): string[] {
  if (typeof candidate !== 'object' || candidate === null) {
    return ['an event must be an object'];
  }
  // Every field is read as unknown and checked below.
  const event = candidate as Record<string, unknown>;
  return [
    ...fieldProblems(event),
    ...enumProblems(event),
    ...timestampProblems(event),
    ...digestProblems(event),
    ...costProblems(event),
  ];
}

function fieldProblems(event: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const key of EVENT_SCHEMA.required) {
    if (event[key] === undefined) problems.push(`${key} is required`);
  }
  for (const key of Object.keys(event)) {
    if (!(key in EVENT_SCHEMA.properties)) problems.push(`${key} is not a field of v1`);
  }
  if (event['schemaVersion'] !== EVENT_SCHEMA_VERSION) {
    problems.push(`schemaVersion must be ${EVENT_SCHEMA_VERSION}`);
  }
  return problems;
}

const ENUM_FIELDS: readonly [string, readonly string[]][] = [
  ['actorType', Object.values(ACTOR_TYPE)],
  ['surface', Object.values(EVENT_SURFACE)],
  ['class', Object.values(TOOL_CLASS)],
  ['effect', Object.values(DECISION_EFFECT)],
  ['mode', Object.values(ENFORCEMENT_MODE)],
];

function enumProblems(event: Record<string, unknown>): string[] {
  return ENUM_FIELDS.flatMap(([key, allowed]) => {
    const value = event[key];
    if (value === undefined || allowed.includes(String(value))) return [];
    return [`${key} must be one of ${allowed.join(', ')}`];
  });
}

function timestampProblems(event: Record<string, unknown>): string[] {
  const at = event['at'];
  if (typeof at === 'string' && Number.isNaN(Date.parse(at))) {
    return ['at must be an ISO 8601 timestamp'];
  }
  return [];
}

// A digest field holding something long is the shape of a payload that escaped.
function digestProblems(event: Record<string, unknown>): string[] {
  return DIGEST_FIELDS.flatMap((key) => {
    const value = event[key];
    if (typeof value === 'string' && value.length > LONGEST_FIELD) {
      return [`${key} looks like content rather than a digest`];
    }
    return [];
  });
}

// A reported cost that is not a finite, non-negative number would poison every total.
function costProblems(event: Record<string, unknown>): string[] {
  const cost = event['costUsd'];
  if (cost === undefined) return [];
  if (typeof cost !== 'number' || !Number.isFinite(cost))
    return ['costUsd must be a finite number'];
  if (cost < 0) return ['costUsd cannot be negative'];
  return [];
}

export function isMemnoxEvent(candidate: unknown): candidate is MemnoxEvent {
  return validateEvent(candidate).length === 0;
}
