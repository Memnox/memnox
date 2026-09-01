import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readPolicyRegistry } from '@memnox/local-gate';

const CONFIG_DIR = '.memnox';
const REGISTRY_FILE = 'policies.json';
const AUDIT_FILE = 'audit.jsonl';

export interface LocalCounts {
  policies: number;
  records: number;
}

/**
 * What this machine has been governed with so far. Both are zero on a first run, and
 * saying so is the honest opening: a count read off disk is true at minute zero, where
 * everything else worth showing has to be earned over a day.
 */
export async function readLocalCounts(homeDir: string): Promise<LocalCounts> {
  return {
    policies: await countPolicies(homeDir),
    records: await countRecords(homeDir),
  };
}

async function countPolicies(homeDir: string): Promise<number> {
  try {
    const files = await readPolicyRegistry(join(homeDir, CONFIG_DIR, REGISTRY_FILE));
    return files.length;
  } catch {
    // No registry yet is the ordinary first run, and zero is the true answer.
    return 0;
  }
}

/** One decision per line, so the count is a line count and never a parse. */
async function countRecords(homeDir: string): Promise<number> {
  try {
    const raw = await readFile(join(homeDir, CONFIG_DIR, AUDIT_FILE), 'utf8');
    return raw.split('\n').filter((line) => line.trim().length > 0).length;
  } catch {
    return 0;
  }
}
