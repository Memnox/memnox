import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { MEMNOX_HOME } from '../config/config';
import type { AcceptedSkill } from './skills';
import { writeJsonAtomic } from '../store/atomic-file';

const SKILL_FILE = 'skills.json';

export function skillPathFor(home: string): string {
  return join(home, MEMNOX_HOME, SKILL_FILE);
}

/** Empty means nobody has looked yet, which is why a first run reports everything. */
export async function readAcceptedSkills(home: string): Promise<AcceptedSkill[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(skillPathFor(home), 'utf8'));
    return Array.isArray(parsed) ? (parsed as AcceptedSkill[]) : [];
  } catch {
    return [];
  }
}

export async function writeAcceptedSkills(
  home: string,
  accepted: readonly AcceptedSkill[],
): Promise<void> {
  const path = skillPathFor(home);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeJsonAtomic(path, accepted);
}
