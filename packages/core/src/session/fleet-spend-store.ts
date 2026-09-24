import { join } from 'node:path';
import { MEMNOX_HOME } from '../config/config';
import type { FleetSpend } from './budget';
import { readJsonArray, writeJsonFile } from '../store/json-records';

/**
 * What the workspace last said the rest of the fleet had spent, on disk because the sync
 * loop hears it and the daemon enforces it. Empty means nobody has said, which a fleet
 * budget reads as counting what this machine can see rather than as zero.
 */
const FLEET_FILE = 'fleet-spend.json';

export function fleetSpendPathFor(home: string): string {
  return join(home, MEMNOX_HOME, FLEET_FILE);
}

export async function readFleetSpend(home: string): Promise<FleetSpend[]> {
  return readJsonArray<FleetSpend>(fleetSpendPathFor(home));
}

export async function writeFleetSpend(
  home: string,
  spend: readonly FleetSpend[],
): Promise<void> {
  await writeJsonFile(fleetSpendPathFor(home), spend);
}
