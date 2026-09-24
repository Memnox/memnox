/**
 * The daemon's changes and the drift it notices, written to the ledger as `config` rows,
 * so `timeline` and `why` answer "what changed this agent's config, and when".
 */
import { join } from 'node:path';

import {
  ACTOR_TYPE,
  DECISION_EFFECT,
  EVENT_SCHEMA_VERSION,
  EVENT_SURFACE,
  loadOrCreateConfig,
  MEMNOX_HOME,
  newEventId,
  openLedger,
  type MemnoxEvent,
  type ToolClass,
} from '@memnox/core';

import { KEEPER_STATE_FILE } from './keeper-state';
import { KEPT_FILE } from './kept';

/** Who a row names when a change belongs to no one agent, such as a server three agents share. */
const KEEPER_AGENT = 'memnox daemon';

const EVENT_ID_PREFIX = /^evt_/;
const CONFIG_SESSION_PREFIX = 'cfg_';

/** Where the daemon's own rows sit, since no rule file decided them. */
const KEEPER_LAYER = 'machine';

/** Which of the daemon's two jobs a row came from, named as `why` prints a rule. */
export const CONFIG_RULE = {
  /** Setup asked for the boundary to be kept, and this pass kept it. */
  KEPT: { name: 'keep the boundary setup drew', file: KEPT_FILE },
  /** Nothing was changed: the daemon noticed an agent's reach move. */
  DRIFT: { name: 'watch for capability drift', file: KEEPER_STATE_FILE },
} as const;

type ConfigRule = (typeof CONFIG_RULE)[keyof typeof CONFIG_RULE];

/** One change, as the ledger keeps it: which file, and a before and after in words. */
export interface ConfigRecord {
  operation: string;
  /** The agent it concerns, where there is exactly one. */
  agent?: string;
  /** The file that changed. A path, never its contents. */
  file?: string;
  summary: string;
  /** Write when the daemon changed the file, read when it only noticed a change. */
  class: ToolClass;
  rule: ConfigRule;
}

/**
 * Appends each change as one allowed `config` row, all under one session for the pass. A
 * ledger that will not open loses the rows and never the pass, as with every other seam.
 */
export async function recordConfigChanges(
  home: string,
  records: readonly ConfigRecord[],
  now: Date,
): Promise<void> {
  if (records.length === 0) return;
  const ledger = openLedger(home);
  if (ledger === null) return;
  try {
    const { mode } = await loadOrCreateConfig(home);
    // One pass is one piece of work, so its rows share a session the timeline groups them under.
    const sessionId = newEventId().replace(EVENT_ID_PREFIX, CONFIG_SESSION_PREFIX);
    for (const record of records) {
      await ledger.append(
        rowOf(home, record, { at: now.toISOString(), sessionId, mode }),
      );
    }
  } finally {
    ledger.close();
  }
}

interface RowFrame {
  at: string;
  sessionId: string;
  mode: MemnoxEvent['mode'];
}

function rowOf(home: string, record: ConfigRecord, frame: RowFrame): MemnoxEvent {
  return {
    id: newEventId(),
    schemaVersion: EVENT_SCHEMA_VERSION,
    at: frame.at,
    sessionId: frame.sessionId,
    agent: record.agent ?? KEEPER_AGENT,
    actorType: ACTOR_TYPE.AUTOMATION,
    surface: EVENT_SURFACE.CONFIG,
    operation: record.operation,
    ...(record.file === undefined ? {} : { target: record.file }),
    class: record.class,
    effect: DECISION_EFFECT.ALLOW,
    mode: frame.mode,
    reason: record.summary,
    rule: {
      name: record.rule.name,
      layer: KEEPER_LAYER,
      file: join(home, MEMNOX_HOME, record.rule.file),
    },
  };
}
