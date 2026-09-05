import { join } from 'node:path';
import {
  loadOrCreateConfig,
  loadPolicySet,
  readPolicyRegistry,
  versionPolicySet,
  type Policy,
  type UnreadablePolicyFile,
} from '@memnox/core';

const CONFIG_DIR = '.memnox';
const REGISTRY_FILE = 'policies.json';

export interface LocalCounts {
  /** The rules actually in force, so "governed" can be counted rather than guessed. */
  policies: Policy[];
  /** Files that are there and would not load. Never reported as zero rules. */
  unreadable: UnreadablePolicyFile[];
  /** Content hash of the rule set, so two machines can be compared without diffing. */
  policyVersion: string;
  /** Agents somebody decided are allowed here. Empty means nobody has decided. */
  approvedAgents: string[];
}

/**
 * The rules on this machine, loaded rather than counted. A file count would let the
 * scan print a reassuring "8 governed" about rules that cover none of what it just
 * listed, which is the one lie the whole screen exists to avoid.
 *
 * Loaded file by file: the registry names every repository on the disk, and one stale
 * file must not blank the rest. What did not load is carried, never swallowed.
 */
export async function readLocalCounts(homeDir: string): Promise<LocalCounts> {
  const config = await loadOrCreateConfig(homeDir);
  const approvedAgents = config.approvedAgents;
  const empty = { policies: [], unreadable: [], policyVersion: 'none', approvedAgents };

  let files: string[];
  try {
    files = await readPolicyRegistry(join(homeDir, CONFIG_DIR, REGISTRY_FILE));
  } catch {
    // No registry yet is the ordinary first run, and no rules is the true answer.
    return empty;
  }
  if (files.length === 0) return empty;

  const set = await loadPolicySet(files);
  return {
    policies: set.policies,
    unreadable: set.unreadable,
    policyVersion:
      set.policies.length === 0 ? 'none' : versionPolicySet(set.policies).version,
    approvedAgents,
  };
}
