import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { MEMNOX_HOME } from '../config/config';
import type { FleetSpend } from './budget';
import { writeJsonAtomic } from '../store/atomic-file';

const FLEET_FILE = 'fleet-spend.json';

export function fleetSpendPathFor(home: string): string {
  return join(home, MEMNOX_HOME, FLEET_FILE);
}

/**
 * What the workspace last said the rest of the fleet had spent.
 *
 * On disk because the thing that hears it is the sync loop and the thing that enforces
 * is the daemon, and they are different processes. Empty means nobody has said —
 * which a fleet budget reads as "count what I can see myself" rather than as zero.
 */
export async function readFleetSpend(home: string): Promise<FleetSpend[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(fleetSpendPathFor(home), 'utf8'));
    return Array.isArray(parsed) ? (parsed as FleetSpend[]) : [];
  } catch {
    return [];
  }
}

export async function writeFleetSpend(
  home: string,
  spend: readonly FleetSpend[],
): Promise<void> {
  const path = fleetSpendPathFor(home);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeJsonAtomic(path, spend);
}
