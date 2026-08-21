import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { readPolicyRegistry } from '@memnox/local-gate';

/** One runtime serves every project, so a second repository has to join the list. */
const CONFIG_DIR = '.memnox';
const REGISTRY_FILE = 'policies.json';
const DIR_MODE = 0o700;

export function policyRegistryPath(homeDir: string): string {
  return join(homeDir, CONFIG_DIR, REGISTRY_FILE);
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
  const path = policyRegistryPath(homeDir);
  await mkdir(dirname(path), { recursive: true, mode: DIR_MODE });
  await writeFile(path, `${JSON.stringify({ files }, null, 2)}\n`, 'utf8');
  return files;
}
