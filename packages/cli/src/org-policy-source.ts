import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writePoliciesToFile } from '@memnox/local-gate';
import type { Policy } from '@memnox/policy-engine';

const CONFIG_DIR = '.memnox';
const ORG_DIR = 'org';
/** Owner-only: these rules govern the machine, and nothing else should edit them. */
const DIR_MODE = 0o700;

/**
 * Where a pulled rule set lands — its own file, never the repository's.
 *
 * Keeping them apart is the whole point. The engine composes every registered
 * source and resolves conflicts most-restrictive-wins, so a developer editing
 * their own `memnox.policies.yaml` can add rules but cannot loosen one the
 * organization sent. Writing into the repository file instead would put both
 * sets under the same edit, and the org half would be one deletion away.
 */
export function orgPolicyPath(homeDir: string, workspace: string): string {
  return join(homeDir, CONFIG_DIR, ORG_DIR, `${safeName(workspace)}.yaml`);
}

/** A workspace id reaches this from a URL; it must not escape the directory. */
function safeName(workspace: string): string {
  return workspace.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export async function writeOrgPolicies(
  homeDir: string,
  workspace: string,
  policies: readonly Policy[],
): Promise<string> {
  const path = orgPolicyPath(homeDir, workspace);
  await mkdir(dirname(path), { recursive: true, mode: DIR_MODE });
  // Temp-file-and-rename, so a crash mid-write cannot leave a truncated rule set.
  await writePoliciesToFile(path, policies);
  return path;
}
