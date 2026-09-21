/** Listing a directory that holds one JSON file per record, named by the record's id. */
import { readdir } from 'node:fs/promises';

export const JSON_SUFFIX = '.json';

/** The record ids a directory holds, from the files named after them. */
export async function idsIn(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    // The directory has never been written to, which is the same as holding nothing.
    return [];
  }
  return names
    .filter((name) => name.endsWith(JSON_SUFFIX))
    .map((name) => name.slice(0, -JSON_SUFFIX.length));
}

/**
 * Every record a directory holds, in no particular order. A record that will not read is
 * skipped rather than thrown over, so one torn file cannot hide the rest.
 */
export async function readAllIn<T>(
  dir: string,
  read: (id: string) => Promise<T | null>,
): Promise<T[]> {
  const found: T[] = [];
  for (const id of await idsIn(dir)) {
    const record = await read(id);
    if (record !== null) found.push(record);
  }
  return found;
}
