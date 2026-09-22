/**
 * Turning this machine's protection off on purpose and back on: the file every seam reads,
 * a ledger row naming who and why, and a report the team sees on an enrolled machine.
 */
import {
  ACTOR_TYPE,
  clearProtectionStop,
  DECISION_EFFECT,
  EVENT_SCHEMA_VERSION,
  EVENT_SURFACE,
  loadOrCreateConfig,
  MINUTE_MS,
  newEventId,
  openLedger,
  protectionStopPath,
  readProtectionStop,
  stopHasEnded,
  TOOL_CLASS,
  writeProtectionStop,
  type MemnoxEvent,
  type ProtectionStop,
} from '@memnox/core';

import { CLOUD_EVENT } from '../sync/cloud-event';
import { queueProtectionChange } from '../sync/protection-changes';

/** Who a row names when the time a stop was given ran out and nobody ran `start`. */
const STOP_TIMER = 'the timer';

/** The two acts, as the ledger spells them. */
const PROTECTION_OPERATION = {
  STOP: 'protection.stop',
  START: 'protection.start',
} as const;

type ProtectionOperation =
  (typeof PROTECTION_OPERATION)[keyof typeof PROTECTION_OPERATION];

/** Where these rows sit, since no rule file decided them. */
const STOP_LAYER = 'machine';
const STOP_RULE = 'memnox stop';
const STOP_AGENT = 'memnox';
const STOP_SESSION_PREFIX = 'stp_';
const EVENT_ID_PREFIX = /^evt_/;

interface StopRequest {
  by: string;
  reason?: string;
  /** Absent means until somebody runs `memnox start`. */
  minutes?: number;
  now: Date;
}

/** What the act did, and whether the team will hear of it. */
interface ProtectionAct {
  stop: ProtectionStop;
  reported: boolean;
}

/** Writes the stop, keeping the mode in force so `start` returns to exactly that. */
export async function stopProtection(
  home: string,
  request: StopRequest,
): Promise<ProtectionAct> {
  const { mode } = await loadOrCreateConfig(home);
  const stop: ProtectionStop = {
    at: request.now.toISOString(),
    by: request.by,
    mode,
    ...(request.reason === undefined ? {} : { reason: request.reason }),
    ...(request.minutes === undefined
      ? {}
      : {
          until: new Date(
            request.now.getTime() + request.minutes * MINUTE_MS,
          ).toISOString(),
        }),
  };
  await writeProtectionStop(home, stop);
  const reported = await keepRecord(home, {
    operation: PROTECTION_OPERATION.STOP,
    stop,
    by: request.by,
    at: stop.at,
  });
  return { stop, reported };
}

/** Clears the stop. Null when protection was not stopped, so there was nothing to start. */
export async function startProtection(
  home: string,
  request: { by: string; now: Date },
): Promise<ProtectionAct | null> {
  const stop = await readProtectionStop(home);
  if (stop === null) return null;
  await clearProtectionStop(home);
  const reported = await keepRecord(home, {
    operation: PROTECTION_OPERATION.START,
    stop,
    by: request.by,
    at: request.now.toISOString(),
  });
  return { stop, reported };
}

/** A timed stop whose time ran out, cleared and recorded; null while none has. */
export async function endStopWhenDue(
  home: string,
  now: Date,
): Promise<ProtectionStop | null> {
  const stop = await readProtectionStop(home);
  if (stop === null || !stopHasEnded(stop, now)) return null;
  await startProtection(home, { by: STOP_TIMER, now });
  return stop;
}

/** What the desktop says when a stop runs out, since nobody ran anything to hear it. */
export function describeResumed(stop: ProtectionStop): string {
  return `Memnox protection is back on, in ${stop.mode}: the stop ${stop.by} set ran out.`;
}

interface ProtectionRecord {
  operation: ProtectionOperation;
  stop: ProtectionStop;
  by: string;
  at: string;
}

/** The ledger row, and the report for the team, which only an enrolled machine keeps. */
async function keepRecord(home: string, record: ProtectionRecord): Promise<boolean> {
  const row = rowOf(home, record);
  const ledger = openLedger(home);
  if (ledger !== null) {
    try {
      await ledger.append(row);
    } finally {
      ledger.close();
    }
  }
  return queueProtectionChange(home, {
    id: row.id,
    kind:
      record.operation === PROTECTION_OPERATION.STOP
        ? CLOUD_EVENT.PROTECTION_STOPPED
        : CLOUD_EVENT.PROTECTION_STARTED,
    at: record.at,
    by: record.by,
    mode: record.stop.mode,
    ...(record.by === STOP_TIMER ? { timer: true as const } : {}),
    ...(record.stop.reason === undefined ? {} : { reason: record.stop.reason }),
    ...(record.stop.until === undefined ? {} : { until: record.stop.until }),
  });
}

function rowOf(home: string, record: ProtectionRecord): MemnoxEvent {
  const id = newEventId();
  const timer = record.by === STOP_TIMER;
  return {
    id,
    schemaVersion: EVENT_SCHEMA_VERSION,
    at: record.at,
    sessionId: id.replace(EVENT_ID_PREFIX, STOP_SESSION_PREFIX),
    agent: STOP_AGENT,
    actorType: timer ? ACTOR_TYPE.AUTOMATION : ACTOR_TYPE.HUMAN,
    ...(timer ? {} : { principal: record.by }),
    surface: EVENT_SURFACE.CONFIG,
    operation: record.operation,
    class: TOOL_CLASS.WRITE,
    effect: DECISION_EFFECT.ALLOW,
    mode: record.stop.mode,
    reason: describeRecord(record),
    rule: { name: STOP_RULE, layer: STOP_LAYER, file: protectionStopPath(home) },
  };
}

function describeRecord(record: ProtectionRecord): string {
  const { stop } = record;
  if (record.operation === PROTECTION_OPERATION.START) {
    return `protection back on in ${stop.mode}, by ${record.by}`;
  }
  const because = stop.reason === undefined ? 'no reason given' : stop.reason;
  const until = stop.until === undefined ? 'until started' : `until ${stop.until}`;
  return `protection stopped by ${stop.by}, ${until}: ${because}`;
}
