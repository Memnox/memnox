import { join } from 'node:path';
import { loadPolicyFiles, readPolicyRegistry, type Policy } from '@memnox/core';

const CONFIG_DIR = '.memnox';
const REGISTRY_FILE = 'policies.json';

export interface LocalCounts {
  /** The rules actually in force, so "governed" can be counted rather than guessed. */
  policies: Policy[];
  /** Set when a rule set exists and would not load — never reported as zero rules. */
  unreadable?: string;
}

/**
 * The rules on this machine, loaded rather than counted. A file count would let the
 * scan print a reassuring "8 governed" about rules that cover none of what it just
 * listed, which is the one lie the whole screen exists to avoid.
 */
export async function readLocalCounts(homeDir: string): Promise<LocalCounts> {
  let files: string[];
  try {
    files = await readPolicyRegistry(join(homeDir, CONFIG_DIR, REGISTRY_FILE));
  } catch {
    // No registry yet is the ordinary first run, and no rules is the true answer.
    return { policies: [] };
  }
  if (files.length === 0) return { policies: [] };

  try {
    return { policies: await loadPolicyFiles(files) };
  } catch (err) {
    return {
      policies: [],
      unreadable: err instanceof Error ? err.message.split('\n')[0] : String(err),
    };
  }
}
