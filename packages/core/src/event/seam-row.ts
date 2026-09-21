import { randomUUID } from 'node:crypto';

import type { EventRuleRef } from './event';
import { SqliteEventStore } from './sqlite-store';

/**
 * What every seam's row shares: the id, the unnamed agent, the rule it cites, the ledger.
 */

/** The agent a row or a hold names when nobody told the seam which one it was. */
export const UNNAMED_AGENT = 'an agent';

/**
 * Enough of a UUID to be unique in one ledger
 * without making every row wider than it needs.
 */
const EVENT_ID_CHARS = 20;

export function newEventId(): string {
  return `evt_${randomUUID().replace(/-/g, '').slice(0, EVENT_ID_CHARS)}`;
}

/**
 * A matched policy carries its name and nothing
 * else, so this is all a seam can honestly cite.
 */
export function localRuleRef(name: string): EventRuleRef {
  return { name, layer: 'project', file: 'policy' };
}

/** The ledger, or null when it will not open. A lost row never stops the work. */
export function openLedger(home: string): SqliteEventStore | null {
  try {
    return SqliteEventStore.forHome(home);
  } catch {
    return null;
  }
}
