import {
  loadOrCreateConfig,
  loadPolicySet,
  versionPolicySet,
  type Policy,
  type UnreadablePolicyFile,
} from '@memnox/core';
import { readRegisteredFiles } from './policy-path';

/**
 * The two numbers the scan closes on: what can act here, and how much of it is governed.
 * Rules are loaded rather than counted as files, so rules covering nothing count as none.
 */
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

const NO_RULES_VERSION = 'none';

/** The registered rules, file by file so one stale file never blanks the rest. */
export async function readLocalCounts(homeDir: string): Promise<LocalCounts> {
  const config = await loadOrCreateConfig(homeDir);
  const approvedAgents = config.approvedAgents;
  const files = await readRegisteredFiles(homeDir);
  if (files.length === 0) {
    return {
      policies: [],
      unreadable: [],
      policyVersion: NO_RULES_VERSION,
      approvedAgents,
    };
  }

  const set = await loadPolicySet(files);
  return {
    policies: set.policies,
    unreadable: set.unreadable,
    policyVersion:
      set.policies.length === 0
        ? NO_RULES_VERSION
        : versionPolicySet(set.policies).version,
    approvedAgents,
  };
}
