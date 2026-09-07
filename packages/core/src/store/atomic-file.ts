import { rename, writeFile } from 'node:fs/promises';

/**
 * Written whole, or not at all.
 *
 * `writeFile` truncates and then writes, so a reader arriving in between sees an empty
 * or half-written file. Every store here parses JSON and treats a parse failure as
 * "not there", which is right for a file that was never created and wrong for one
 * being rewritten — and the two are indistinguishable at the call site.
 *
 * That cost an approval: a held call being answered was read mid-write, reported as
 * gone, and the waiter stopped waiting — so a yes somebody had just typed became a
 * refusal, on a busy machine, sometimes. A lease being renewed and a pause being
 * lifted have the same shape and worse consequences.
 *
 * A rename is atomic on every platform this runs on, so no reader ever sees the
 * middle. The scratch name is unique per write rather than per process: two writers
 * inside one process sharing a temporary is the same tear one level down, and the
 * second one's rename finds the file the first already moved away.
 */
let writes = 0;

export async function writeAtomic(path: string, contents: string): Promise<void> {
  writes += 1;
  const scratch = `${path}.${process.pid}.${writes}.tmp`;
  await writeFile(scratch, contents, { encoding: 'utf8', mode: 0o600 });
  await rename(scratch, path);
}

/** The same, for a record that is stored as pretty JSON. Which is all of them. */
export async function writeJsonAtomic(path: string, record: unknown): Promise<void> {
  await writeAtomic(path, `${JSON.stringify(record, null, 2)}\n`);
}
