import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeAtomic, writeJsonAtomic } from '../src/store/atomic-file';
import { PendingApprovals } from '../src/gate/pending';
import { HOLD_ANSWER, type HoldRequest } from '../src/gate/hold';

const home = (): Promise<string> => mkdtemp(join(tmpdir(), 'memnox-atomic-'));

describe('a record is written whole or not at all', () => {
  it('leaves no scratch file behind', async () => {
    const dir = await home();
    await writeJsonAtomic(join(dir, 'thing.json'), { a: 1 });

    const names = await readdir(dir);
    expect(names).toEqual(['thing.json']);
  });

  it('replaces the previous contents rather than appending to them', async () => {
    const dir = await home();
    const path = join(dir, 'thing.json');
    await writeAtomic(path, 'first');
    await writeAtomic(path, 'second');
    expect(await readFile(path, 'utf8')).toBe('second');
  });
});

const request: HoldRequest = {
  sessionId: 'ses_1',
  agent: 'hermes',
  operation: 'vercel.deploy-production',
  fingerprint: 'abc12345',
  reason: 'held',
};

describe('a reader never sees a half-written approval', () => {
  /* `writeFile` truncates and then writes, so a reader arriving in between saw an
     empty file, `read` reported it as gone, and the waiter stopped waiting — a yes
     somebody had just typed became a refusal, on a busy machine, sometimes. */
  it('reads back an answer under a rewrite it is racing', async () => {
    const approvals = new PendingApprovals(await home());
    const pending = await approvals.raise(request, '2026-09-05T10:00:00.000Z', 60_000);

    const rewrites = Array.from({ length: 40 }, (_unused, i) =>
      approvals.answer(
        pending.id,
        HOLD_ANSWER.ONCE,
        `person-${i}`,
        '2026-09-05T10:00:01.000Z',
      ),
    );
    const reads = Array.from({ length: 200 }, () => approvals.read(pending.id));

    const [, seen] = await Promise.all([Promise.all(rewrites), Promise.all(reads)]);
    // Never null: the record exists throughout, however many writers are mid-flight.
    expect(seen.every((each) => each !== null)).toBe(true);
    expect(seen.every((each) => each?.id === pending.id)).toBe(true);
  });

  it('keeps the first answer, so two people cannot overwrite each other', async () => {
    const approvals = new PendingApprovals(await home());
    const pending = await approvals.raise(request, '2026-09-05T10:00:00.000Z', 60_000);

    await approvals.answer(
      pending.id,
      HOLD_ANSWER.ONCE,
      'first',
      '2026-09-05T10:00:01.000Z',
    );
    await approvals.answer(
      pending.id,
      HOLD_ANSWER.DENY,
      'second',
      '2026-09-05T10:00:02.000Z',
    );

    expect((await approvals.read(pending.id))?.answeredBy).toBe('first');
  });
});
