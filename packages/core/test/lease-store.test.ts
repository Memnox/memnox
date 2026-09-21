import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MEMNOX_HOME } from '../src/config/config';
import {
  LEASE_OUTCOME,
  LeaseRegistry,
  leaseDirFor,
  processAlive,
} from '../src/coordination/lease-store';
import type { LeaseHolder } from '../src/coordination/lease';
import { leaseScopeFor } from '../src/coordination/writes';

const NOW = '2026-09-05T10:00:00.000Z';
const at = (minutes: number): string =>
  new Date(Date.parse(NOW) + minutes * 60_000).toISOString();

const cursor: LeaseHolder = { agent: 'cursor', sessionId: 'ses_1', pid: 111 };
const claude: LeaseHolder = { agent: 'claude-code', sessionId: 'ses_2', pid: 222 };

const home = (): Promise<string> => mkdtemp(join(tmpdir(), 'memnox-lease-'));
const living = (): boolean => true;

describe('one winner', () => {
  it('gives an overlapping path to the second asker as a refusal, not a second lease', async () => {
    const registry = new LeaseRegistry(await home(), living);
    const first = await registry.take({ path: 'src/billing', holder: cursor }, NOW);
    expect(first.outcome).toBe(LEASE_OUTCOME.TAKEN);

    const second = await registry.take(
      { path: 'src/billing/invoice.ts', holder: claude },
      at(1),
    );
    expect(second.outcome).toBe(LEASE_OUTCOME.HELD_BY_ANOTHER);
    if (second.outcome !== LEASE_OUTCOME.HELD_BY_ANOTHER) return;
    // The holder rides with the refusal, or the waiter has nobody to go and ask.
    expect(second.holding.holder.agent).toBe('cursor');
  });

  it('lets a sibling directory through, because the prefix trap is the whole risk', async () => {
    const registry = new LeaseRegistry(await home(), living);
    await registry.take({ path: 'src/billing', holder: cursor }, NOW);
    expect(
      (await registry.take({ path: 'src/billing-legacy', holder: claude }, at(1)))
        .outcome,
    ).toBe(LEASE_OUTCOME.TAKEN);
  });

  /* Five callers racing through the real store. They interleave at every `await`, which
     is where a check-then-write would lose; the cross-process half of the guarantee is
     the atomic `mkdir` below, which the kernel enforces the same way for both. */
  it('hands one lease to one of five simultaneous askers', async () => {
    const registry = new LeaseRegistry(await home(), living);
    const results = await Promise.all(
      Array.from({ length: 5 }, (_unused, index) =>
        registry.take(
          {
            path: 'src/billing',
            holder: {
              agent: `agent-${index}`,
              sessionId: `ses_${index}`,
              pid: 1000 + index,
            },
          },
          NOW,
        ),
      ),
    );

    const taken = results.filter((each) => each.outcome === LEASE_OUTCOME.TAKEN);
    expect(taken).toHaveLength(1);
    expect(
      results.filter((each) => each.outcome === LEASE_OUTCOME.HELD_BY_ANOTHER),
    ).toHaveLength(4);
  });

  it('waits behind a lock another process is holding, then takes it', async () => {
    const where = await home();
    await mkdir(join(leaseDirFor(where), '.lock'), { recursive: true });
    const registry = new LeaseRegistry(where, living);

    const taking = registry.take({ path: 'src/billing', holder: cursor }, NOW);
    // Nothing may be written while somebody else holds the mutex.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await registry.all()).toEqual([]);

    await rm(join(leaseDirFor(where), '.lock'), { recursive: true });
    expect((await taking).outcome).toBe(LEASE_OUTCOME.TAKEN);
  }, 15_000);

  it('reclaims a lock a crashed process left behind, rather than wedging the machine', async () => {
    const where = await home();
    const lock = join(leaseDirFor(where), '.lock');
    await mkdir(lock, { recursive: true });
    // Backdated past any honest critical section here.
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);

    const registry = new LeaseRegistry(where, living);
    expect((await registry.take({ path: 'src', holder: cursor }, NOW)).outcome).toBe(
      LEASE_OUTCOME.TAKEN,
    );
  }, 15_000);
});

describe('one session, one lease', () => {
  it('renews rather than taking a second lease on the same tree', async () => {
    const registry = new LeaseRegistry(await home(), living);
    await registry.take(
      { path: 'src/billing', holder: cursor, minutes: 30, activity: 'wrote invoice.ts' },
      NOW,
    );
    await registry.take(
      {
        path: 'src/billing/tax.ts',
        holder: cursor,
        minutes: 30,
        activity: 'wrote tax.ts',
      },
      at(1),
    );

    const held = await registry.held(at(2));
    expect(held).toHaveLength(1);
    expect(held[0]?.activity).toEqual(['wrote invoice.ts', 'wrote tax.ts']);
  });

  it('records ten writes in one directory as one lease, not ten', async () => {
    const registry = new LeaseRegistry(await home(), living);
    const directories = (path: string): boolean => !path.endsWith('.ts');
    for (let i = 0; i < 10; i += 1) {
      const scope = leaseScopeFor(`src/billing/file-${i}.ts`, directories);
      await registry.take(
        { path: scope, holder: cursor, minutes: 30, activity: `wrote file-${i}.ts` },
        at(i),
      );
    }
    const held = await registry.held(at(11));
    expect(held).toHaveLength(1);
    expect(held[0]?.path).toBe('src/billing');
  });
});

describe('a dead owner never blocks anybody', () => {
  it('lets the next writer through once the holder is gone', async () => {
    const where = await home();
    const dying = new LeaseRegistry(where, (pid) => pid === cursor.pid);
    await dying.take({ path: 'src/billing', holder: cursor }, NOW);

    const after = new LeaseRegistry(where, () => false);
    expect(
      (await after.take({ path: 'src/billing', holder: claude }, at(1))).outcome,
    ).toBe(LEASE_OUTCOME.TAKEN);
  });

  it('asks the operating system rather than assuming', () => {
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(2_147_483_6)).toBe(false);
  });
});

describe('letting go', () => {
  it('refuses to release a lease that belongs to another session', async () => {
    const registry = new LeaseRegistry(await home(), living);
    const taken = await registry.take({ path: 'src', holder: cursor }, NOW);
    if (taken.outcome !== LEASE_OUTCOME.TAKEN) throw new Error('not taken');

    expect((await registry.release(taken.lease.id, claude, at(1))).outcome).toBe(
      LEASE_OUTCOME.NOT_YOURS,
    );
  });

  it('releases everything a session held when the session ends', async () => {
    const registry = new LeaseRegistry(await home(), living);
    await registry.take({ path: 'src/billing', holder: cursor }, NOW);
    await registry.take({ path: 'docs', holder: cursor }, at(1));
    await registry.take({ path: 'src/auth', holder: claude }, at(1));

    const released = await registry.releaseSession('ses_1', at(2));
    expect(released).toHaveLength(2);
    const left = await registry.held(at(3));
    expect(left.map((lease) => lease.holder.agent)).toEqual(['claude-code']);
  });

  it('keeps a takeover in the record, and hands the path to the taker', async () => {
    const registry = new LeaseRegistry(await home(), living);
    const taken = await registry.take({ path: 'src/billing', holder: cursor }, NOW);
    if (taken.outcome !== LEASE_OUTCOME.TAKEN) throw new Error('not taken');

    const over = await registry.takeOver(
      taken.lease.id,
      claude,
      'the build is red',
      at(5),
    );
    expect(over.outcome).toBe(LEASE_OUTCOME.TAKEN);

    const held = await registry.held(at(6));
    expect(held).toHaveLength(1);
    expect(held[0]?.holder.agent).toBe('claude-code');

    const original = await registry.read(taken.lease.id);
    expect(original?.takenOver?.reason).toBe('the build is red');
  });

  it('forgets what nobody holds, and keeps what somebody does', async () => {
    const registry = new LeaseRegistry(await home(), living);
    await registry.take({ path: 'src/billing', holder: cursor, minutes: 10 }, NOW);
    await registry.take({ path: 'docs', holder: claude, minutes: 30 }, at(200));

    expect(await registry.forget(at(215))).toBe(1);
    expect((await registry.all()).map((lease) => lease.path)).toEqual(['docs']);
  });
});

describe('what lands on disk', () => {
  it('writes leases only the owner can read', async () => {
    const where = await home();
    const registry = new LeaseRegistry(where, living);
    await registry.take({ path: 'src', holder: cursor }, NOW);

    const dir = join(where, MEMNOX_HOME, 'leases');
    const [file] = (await readdir(dir)).filter((name) => name.endsWith('.json'));
    const mode = (await stat(join(dir, file as string))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('ignores a file that is not a lease rather than failing the read', async () => {
    const where = await home();
    await mkdir(leaseDirFor(where), { recursive: true });
    await writeFile(join(leaseDirFor(where), 'notes.txt'), 'not a lease');
    expect(await new LeaseRegistry(where, living).all()).toEqual([]);
  });
});

describe('whether a holder is still there', () => {
  it('never calls init alive, so a lease recorded against it is reclaimable', () => {
    // It outlives everything, so treating it as alive made such a lease permanent.
    expect(processAlive(1)).toBe(false);
    expect(processAlive(0)).toBe(false);
  });

  it('still sees this process', () => {
    expect(processAlive(process.pid)).toBe(true);
  });
});

/* An editor's hold is short and kept alive by its session working, so an agent
   that goes quiet lets its lines go in minutes rather than half an hour. */
describe('a hold that lasts while its session works', () => {
  const at = (minutes: number) =>
    new Date(Date.parse(NOW) + minutes * 60_000).toISOString();

  it('lapses a few minutes after the session stops, and lasts while it renews', async () => {
    const registry = new LeaseRegistry(await home(), living);
    await registry.take(
      { path: 'src/billing.ts', holder: cursor, minutes: 5, activity: 'edit' },
      NOW,
    );

    expect(await registry.renewSession(cursor.sessionId, at(4), 5)).toBe(1);
    expect(await registry.held(at(8))).toHaveLength(1);
    expect(await registry.held(at(10))).toEqual([]);
  });

  it('never cuts a longer hold short', async () => {
    const registry = new LeaseRegistry(await home(), living);
    await registry.take(
      { path: 'src', holder: cursor, minutes: 30, activity: 'shell' },
      NOW,
    );

    await registry.renewSession(cursor.sessionId, at(1), 5);

    expect(await registry.held(at(20))).toHaveLength(1);
  });
});
