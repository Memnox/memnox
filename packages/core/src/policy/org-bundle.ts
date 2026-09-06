import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MEMNOX_HOME } from '../config/config';
import { inForce, type Overlay } from './overlay';

/** Written by `memnox sync` and never by hand; `memnox login` is what starts it. */
const ORG_POLICY_FILE = 'org.policies.json';

export function orgPolicyPathFor(home: string): string {
  return join(home, MEMNOX_HOME, ORG_POLICY_FILE);
}

/**
 * Which workspace bundle this machine is running, if it is on one.
 *
 * Carried in the rules file itself so there is not a second place to keep it in
 * step, and read here so a verdict can name it. Absent means not logged in, which
 * is a different answer from behind.
 */
export async function bundleHashOn(home: string): Promise<string | undefined> {
  try {
    const document = JSON.parse(await readFile(orgPolicyPathFor(home), 'utf8')) as {
      bundleHash?: string;
    };
    return document.bundleHash;
  } catch {
    return undefined; // Nothing pulled here.
  }
}

/**
 * What a verdict taken now should be stamped with, so it can be replayed later.
 *
 * The engine computed a state version for every decision and no seam carried it to
 * the ledger, so the one field built to make a freeze visible afterwards was
 * stamped and dropped. Both halves are best effort: a machine that cannot say which
 * bundle it was on still has to be able to record what it did.
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
