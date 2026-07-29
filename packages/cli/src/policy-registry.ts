import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { readPolicyRegistry } from '@memnox/local-gate';

/**
 * The list of rule files this machine's runtime should load.
 *
 * One runtime serves every project, so a second repository joining an already
 * running runtime has to get its rules there somehow. It registers a *path*
 * here and asks for a reload — rule content never travels over the API, so
 * every rule stays reviewable in the diff of the repository that owns it.
 */
const CONFIG_DIR = '.memnox';
const REGISTRY_FILE = 'policies.json';
const DIR_MODE = 0o700;

export function policyRegistryPath(homeDir: string): string {
  return join(homeDir, CONFIG_DIR, REGISTRY_FILE);
}

/**
 * Adds a rule file to the set this machine loads. Absolute and de-duplicated:
 * the runtime resolves these from its own working directory, not the caller's.
 * Returns the full list so a caller can report what is now in force.
 */
export async function registerPolicyFile(
  homeDir: string,
  filePath: string,
): Promise<string[]> {
  const absolute = resolve(filePath);
  const existing = await readPolicyRegistry(policyRegistryPath(homeDir));
  if (existing.includes(absolute)) return existing;

  const files = [...existing, absolute];
  const path = policyRegistryPath(homeDir);
  await mkdir(dirname(path), { recursive: true, mode: DIR_MODE });
  await writeFile(path, `${JSON.stringify({ files }, null, 2)}\n`, 'utf8');
  return files;
}
