import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Somebody's editor or agent config, rewritten through one function: backed up first,
 * written only when the change is real, and left alone when it is not plain JSON.
 */

export const REWRITE = {
  /** The directory the config would live in does not exist, so the product is not here. */
  ABSENT: 'absent',
  UNCHANGED: 'unchanged',
  WRITTEN: 'written',
  /** Not plain JSON, so it was left exactly as it was. */
  UNREADABLE: 'unreadable',
} as const;

type Rewrite = (typeof REWRITE)[keyof typeof REWRITE];

export const BACKUP_SUFFIX = '.memnox-backup';

/** Pretty printed with a trailing newline, the way the editors themselves write these. */
export function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** The previous contents kept beside the file, then the new contents written over it. */
export async function writeBackedUp(
  path: string,
  raw: string,
  next: unknown,
): Promise<void> {
  if (existsSync(path)) await writeFile(`${path}${BACKUP_SUFFIX}`, raw, 'utf8');
  await writeFile(path, jsonText(next), 'utf8');
}

/** A missing file reads as an empty object, so an install can create it. */
export async function rewriteJsonFile<T>(
  path: string,
  transform: (config: T) => T,
): Promise<Rewrite> {
  if (!existsSync(dirname(path))) return REWRITE.ABSENT;
  try {
    const raw = existsSync(path) ? await readFile(path, 'utf8') : '{}';
    // The caller's transform narrows what it reads; anything it does not name is copied through.
    const config = JSON.parse(raw) as T;
    const next = transform(config);
    if (JSON.stringify(next) === JSON.stringify(config)) return REWRITE.UNCHANGED;
    await writeBackedUp(path, raw, next);
    return REWRITE.WRITTEN;
  } catch {
    // Not plain JSON: writing it whole would drop whatever it held that we cannot read.
    return REWRITE.UNREADABLE;
  }
}

/** For an install: true when the change is in place, whether or not this call wrote it. */
export function isInPlace(outcome: Rewrite): boolean {
  return outcome === REWRITE.WRITTEN || outcome === REWRITE.UNCHANGED;
}
