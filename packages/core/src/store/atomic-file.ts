/**
 * Written whole, or not at all, through a rename, because `writeFile` truncates first and a
 * reader arriving mid write would see an empty file.
 */
import { rename, writeFile } from 'node:fs/promises';

const OWNER_ONLY = 0o600;

// Counted per write rather than per process, so two writers never share a scratch file.
let writes = 0;

export async function writeAtomic(path: string, contents: string): Promise<void> {
  writes += 1;
  const scratch = `${path}.${process.pid}.${writes}.tmp`;
  await writeFile(scratch, contents, { encoding: 'utf8', mode: OWNER_ONLY });
  await rename(scratch, path);
}

/** The same, for a record that is stored as pretty JSON. Which is all of them. */
export async function writeJsonAtomic(path: string, record: unknown): Promise<void> {
  await writeAtomic(path, `${JSON.stringify(record, null, 2)}\n`);
}
