import { join } from 'node:path';

import {
  ACTOR_TYPE,
  MEMNOX_HOME,
  readAccount,
  readJsonFile,
  writeJsonFile,
  type EnforcementMode,
} from '@memnox/core';

import { CLOUD_EVENT, eventOf, type CloudEvent } from './cloud-event';

/**
 * Every `memnox stop` and `memnox start` on an enrolled machine, kept until the next sync
 * posts them, because a machine turning its own protection off is something its team sees.
 */

const CHANGES_FILE = 'protection-changes.json';

/** Months of stops and starts; the control plane deduplicates, so an overlap costs nothing. */
const KEPT = 100;

type ProtectionEventKind =
  typeof CLOUD_EVENT.PROTECTION_STOPPED | typeof CLOUD_EVENT.PROTECTION_STARTED;

interface ProtectionChange {
  /** Stable for one change, so a resend is one row on the other side. */
  id: string;
  kind: ProtectionEventKind;
  at: string;
  /** The person, or the timer when a `--for` ran out. */
  by: string;
  /** True when nobody ran `start`: the time a person set ran out. */
  timer?: true;
  reason?: string;
  until?: string;
  /** The mode kept through the stop, which is the mode it comes back to. */
  mode: EnforcementMode;
}

interface ChangesFile {
  changes: ProtectionChange[];
}

function changesPathFor(home: string): string {
  return join(home, MEMNOX_HOME, CHANGES_FILE);
}

export async function readProtectionChanges(home: string): Promise<ProtectionChange[]> {
  const held = await readJsonFile<Partial<ChangesFile>>(changesPathFor(home));
  return held === null || !Array.isArray(held.changes) ? [] : held.changes;
}

/** Kept on an enrolled machine only: with no account there is no team to tell. */
export async function queueProtectionChange(
  home: string,
  change: ProtectionChange,
): Promise<boolean> {
  if ((await readAccount(home)) === null) return false;
  const held = await readProtectionChanges(home);
  await writeJsonFile(changesPathFor(home), { changes: [...held, change].slice(-KEPT) });
  return true;
}

/** A person stopping is a person acting; the timer bringing it back is the machine. */
export function protectionEvents(changes: readonly ProtectionChange[]): CloudEvent[] {
  return changes.map((change) =>
    eventOf({
      kind: change.kind,
      dedupKey: `${change.kind}:${change.id}`,
      subjectId: change.id,
      actorType: change.timer === true ? ACTOR_TYPE.AUTOMATION : ACTOR_TYPE.HUMAN,
      occurredAt: Date.parse(change.at),
      payload: {
        by: change.by,
        mode: change.mode,
        ...(change.reason === undefined ? {} : { reason: change.reason }),
        ...(change.until === undefined ? {} : { until: change.until }),
        ...(change.timer === true ? { timer: true } : {}),
      },
    }),
  );
}
