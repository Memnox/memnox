/**
 * One look by the daemon: what drifted since the last look, which agents went quiet while
 * holding reach, and the new baseline. No MCP server is started, ever, from here.
 */
import type { EnvironmentSnapshot } from '@memnox/core';

import type { ScanSeams } from '../machine-scan';
import { baselineOf, driftSince, lookAtMachine } from '../scan/machine-drift';
import { recordConfigChanges } from './config-events';
import { driftItems, driftRecords, keeperScanSeams, type DriftItem } from './keep-drift';
import { newlyDormant, readDormant, type NamedDormant } from './keep-dormant';
import { readKeeperState, writeKeeperState } from './keeper-state';
import { readKept } from './kept';

interface WatchOutcome {
  /** What drifted since the last look. Empty on the first, which only sets the baseline. */
  items: DriftItem[];
  /** Agents dormant now and not mentioned before. */
  dormant: NamedDormant[];
}

const NOTHING: WatchOutcome = { items: [], dormant: [] };

/**
 * Looks, compares, records and remembers, in that order: the baseline moves only after
 * the rows are written, so a pass that fails is looked at again rather than lost.
 */
export async function watchOnce(
  home: string,
  now: Date,
  scan?: ScanSeams,
): Promise<WatchOutcome> {
  if ((await readKept(home)) === null) return NOTHING;
  const seams = scan ?? keeperScanSeams(home, () => now);
  const state = await readKeeperState(home);
  const look = await lookAtMachine(seams, { probe: false, save: false });
  const items = driftItems(driftSince(state.baseline, look));
  const firstSeen = firstSeenAfter(state.firstSeen, look.snapshot, now);
  const dormant = await readDormant(home, {
    snapshot: look.snapshot,
    history: await seams.snapshots.history(),
    firstSeen,
    now,
  });
  const { fresh, noticed } = newlyDormant(dormant, state.dormantNoticed);
  await recordConfigChanges(home, driftRecords(items), now);
  await writeKeeperState(home, {
    baseline: baselineOf(look),
    firstSeen,
    dormantNoticed: noticed,
  });
  return { items, dormant: fresh };
}

/** Every agent in this look gets a first-seen moment, and one already set never moves. */
function firstSeenAfter(
  before: Readonly<Record<string, string>>,
  snapshot: EnvironmentSnapshot,
  now: Date,
): Record<string, string> {
  const after: Record<string, string> = { ...before };
  for (const agent of snapshot.agents) {
    if (after[agent.id] === undefined) after[agent.id] = now.toISOString();
  }
  return after;
}
