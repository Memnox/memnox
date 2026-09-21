import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writeJsonAtomic } from './atomic-file';
import { JSON_SUFFIX, readAllIn } from './json-dir';

/**
 * How every store under the Memnox home reads and writes JSON, so a missing or torn
 * file means the same thing everywhere: nothing there.
 */

const OWNER_ONLY_DIR = 0o700;

/** The parsed file, or null when it is missing or will not parse. */
export async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    // The caller owns the shape, since every file here was written by the store reading it.
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** The array a file holds, or empty when it is missing, torn or not an array. */
export async function readJsonArray<T>(path: string): Promise<T[]> {
  const parsed = await readJsonFile<unknown>(path);
  // Written by the store that reads it, so the elements are its own shape.
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}

/** Written whole, into an owner only directory created on first write. */
export async function writeJsonFile(path: string, record: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: OWNER_ONLY_DIR });
  await writeJsonAtomic(path, record);
}

/** A directory holding one JSON file per record, named by the record's id. */
export class JsonRecordDir<T> {
  constructor(private readonly dir: string) {}

  pathFor(id: string): string {
    return join(this.dir, `${id}${JSON_SUFFIX}`);
  }

  read(id: string): Promise<T | null> {
    return readJsonFile<T>(this.pathFor(id));
  }

  /** Every record that reads, in no particular order. */
  all(): Promise<T[]> {
    return readAllIn(this.dir, (id) => this.read(id));
  }

  write(id: string, record: T): Promise<void> {
    return writeJsonFile(this.pathFor(id), record);
  }

  async remove(id: string): Promise<void> {
    await rm(this.pathFor(id), { force: true });
  }
}
