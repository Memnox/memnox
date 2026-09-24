import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { MEMNOX_HOME, POLICY_REGISTRY_FILE, readPolicyRegistry } from '@memnox/core';

/**
 * The list of rule files in force, which is what every seam loads. Paths only, so a rule
 * stays in the diff of the repository that owns it.
 */

const DIR_MODE = 0o700;

export function policyRegistryPath(homeDir: string): string {
  return join(homeDir, MEMNOX_HOME, POLICY_REGISTRY_FILE);
}

/** Absolute and de-duplicated: the runtime resolves these from its own directory. */
export async function registerPolicyFile(
  homeDir: string,
  filePath: string,
): Promise<string[]> {
  const absolute = resolve(filePath);
  const existing = await readPolicyRegistry(policyRegistryPath(homeDir));
  if (existing.includes(absolute)) return existing;

  const files = [...existing, absolute];
  await writeRegistry(homeDir, files);
  return files;
}

/**
 * Drops paths from the list. Never automatic, because a checkout on an unmounted drive
 * reads exactly like a deleted one and forgetting its rules would ungovern the machine.
 */
export async function forgetPolicyFiles(
  homeDir: string,
  drop: readonly string[],
): Promise<string[]> {
  const gone = new Set(drop);
  const registered = await readPolicyRegistry(policyRegistryPath(homeDir));
  const files = registered.filter((file) => !gone.has(file));
  await writeRegistry(homeDir, files);
  return files;
}

async function writeRegistry(homeDir: string, files: readonly string[]): Promise<void> {
  const path = policyRegistryPath(homeDir);
  await mkdir(dirname(path), { recursive: true, mode: DIR_MODE });
  await writeFile(path, `${JSON.stringify({ files }, null, 2)}\n`, 'utf8');
}
