import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseEnvironmentModes, type EnvironmentModes } from '@memnox/core';

const ENFORCEMENT_FILE = 'enforcement.json';

/**
 * The modes a control plane last set, kept so a restart does not silently
 * revert to whatever flag the process happened to start with.
 *
 * The startup flag still wins on a cold start: an air-gapped image pinned to
 * `default=enforce` must not be talked down to `off` by a stored file, and an
 * operator editing the flag expects it to mean something.
 */
export async function readStoredEnforcement(
  dataDir: string,
): Promise<EnvironmentModes | undefined> {
  try {
    const raw = await readFile(join(dataDir, ENFORCEMENT_FILE), 'utf8');
    const parsed = parseEnvironmentModes(JSON.parse(raw));
    return typeof parsed === 'string' ? undefined : parsed;
  } catch {
    // Absent or unreadable reads as "never set", which is the safe reading.
    return undefined;
  }
}

export async function writeStoredEnforcement(
  dataDir: string,
  modes: EnvironmentModes,
): Promise<void> {
  const path = join(dataDir, ENFORCEMENT_FILE);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(modes, null, 2)}\n`, 'utf8');
}
