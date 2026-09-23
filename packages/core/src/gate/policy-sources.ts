import { join } from 'node:path';

import { MEMNOX_HOME, POLICY_REGISTRY_FILE } from '../config/config';
import { readPolicyRegistry } from './policy-file';

/**
 * Where a seam finds its rules with no daemon and no network: the environment first, then
 * the registry on disk, since an agent launched from a desktop icon inherits no shell.
 */

/**
 * Policy files evaluated in-process, comma separated, which is what sees the arguments.
 */
export const ENV_POLICIES = 'MEMNOX_POLICIES';
/** Name the local rules match on `agents:`. */
export const ENV_AGENT_NAME = 'MEMNOX_AGENT_NAME';

export const POLICY_PATH_SEPARATOR = ',';

/**
 * The files named in the environment, or the ones
 * this machine registered when it names none.
 */
export async function readPolicyFiles(
  configured: string | undefined,
  home: string,
): Promise<string[]> {
  if (configured === undefined || configured.trim().length === 0) {
    return readPolicyRegistry(join(home, MEMNOX_HOME, POLICY_REGISTRY_FILE));
  }
  return configured
    .split(POLICY_PATH_SEPARATOR)
    .map((path) => path.trim())
    .filter((path) => path.length > 0);
}
