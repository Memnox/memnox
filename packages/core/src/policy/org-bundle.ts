import { join } from 'node:path';
import { MEMNOX_HOME } from '../config/config';
import { inForce, type Overlay } from './overlay';
import { readJsonFile } from '../store/json-records';

/** Written by `memnox sync` and never by hand; `memnox login` is what starts it. */
const ORG_POLICY_FILE = 'org.policies.json';

export function orgPolicyPathFor(home: string): string {
  return join(home, MEMNOX_HOME, ORG_POLICY_FILE);
}

/** Which workspace bundle this machine runs, read from the rules file so a verdict can name it. */
export async function bundleHashOn(home: string): Promise<string | undefined> {
  const document = await readJsonFile<{ bundleHash?: string }>(orgPolicyPathFor(home));
  return document?.bundleHash;
}

/**
 * Stamps a verdict with the bundle and overlays in force, so it replays later. Best
 * effort, because a machine that cannot name its bundle still records what it did.
 */
export async function provenanceOf(
  home: string,
  overlays: readonly Overlay[],
  moment: string,
): Promise<{ bundleHash?: string; conditionsInForce?: readonly string[] }> {
  const hash = await bundleHashOn(home);
  const conditions = inForce(overlays, moment).map((overlay) => overlay.id);
  return {
    ...(hash === undefined ? {} : { bundleHash: hash }),
    ...(conditions.length === 0 ? {} : { conditionsInForce: conditions }),
  };
}
