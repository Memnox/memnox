import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  CONFIG_FILE,
  DEFAULT_CONFIG,
  MEMNOX_HOME,
  parseConfig,
  renderConfig,
  type MemnoxConfig,
} from './config';
import { writeAtomic } from '../store/atomic-file';

export function configPathFor(home: string): string {
  return join(home, MEMNOX_HOME, CONFIG_FILE);
}

/**
 * First run writes the defaults; every run after that reads what is there. Rewriting
 * the file on each start would silently undo an edit somebody made on purpose.
 */
export async function loadOrCreateConfig(home: string): Promise<MemnoxConfig> {
  const path = configPathFor(home);
  try {
    return parseConfig(await readFile(path, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    // First run: the file does not exist yet, which is the one silent case here.
    await saveConfig(home, DEFAULT_CONFIG);
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveConfig(home: string, config: MemnoxConfig): Promise<void> {
  const path = configPathFor(home);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeAtomic(path, renderConfig(config));
}
