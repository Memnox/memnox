import { describe, expect, it } from 'vitest';
import { SHARED_OUTCOME, type SharedTake, type WrittenRegion } from '@memnox/core';
import {
  EditWatcher,
  WATCH_OUTCOME,
  worthWatching,
  type WatcherSeams,
} from '../src/edit-watcher';

const RETRY: WrittenRegion = { lines: [{ from: 7, to: 7 }], symbols: ['retryCharge'] };

function seams(over: Partial<WatcherSeams> = {}): WatcherSeams & {
  taken: string[];
  said: string[];
} {
  const taken: string[] = [];
  const said: string[] = [];
  return {
    taken,
    said,
    exists: () => true,
    heldHere: async () => false,
    changed: async () => RETRY,
    take: async (path): Promise<SharedTake> => {
      taken.push(path);
      return { outcome: SHARED_OUTCOME.TAKEN, lease: {} as never };
    },
    notify: (message) => said.push(message),
    now: () => 1_000_000,
    ...over,
  };
}

/* OpenClaw, Hermes and a person in their editor run no hook, so their edits are
   claimed from the files as they are saved: after the fact, but held against
   every other machine from then on. */
describe('edits nothing hooked', () => {
  it('claims the lines a saved file changed', async () => {
    const world = seams();
    const outcome = await new EditWatcher('/home', world).handle(
      '/repo',
      'src/billing.ts',
    );

    expect(outcome).toBe(WATCH_OUTCOME.CLAIMED);
    expect(world.taken).toEqual(['src/billing.ts']);
  });

  /* A hooked agent here claimed it already; claiming again would be the same
     work twice under two names. */
  it('leaves a file a hooked agent here already holds', async () => {
    const world = seams({ heldHere: async () => true });

    expect(await new EditWatcher('/home', world).handle('/repo', 'src/billing.ts')).toBe(
      WATCH_OUTCOME.SKIPPED,
    );
    expect(world.taken).toEqual([]);
  });

  it('leaves a file that was gone by the time it settled', async () => {
    const world = seams({ exists: () => false });

    expect(await new EditWatcher('/home', world).handle('/repo', 'src/x.ts')).toBe(
      WATCH_OUTCOME.SKIPPED,
    );
    expect(world.taken).toEqual([]);
  });

  it('leaves a file saved back to what was committed', async () => {
    const world = seams({ changed: async () => null });

    expect(await new EditWatcher('/home', world).handle('/repo', 'a.ts')).toBe(
      WATCH_OUTCOME.SKIPPED,
    );
  });

  it('tells the person here, once, when another machine already had those lines', async () => {
    const world = seams({
      take: async (): Promise<SharedTake> => ({
        outcome: SHARED_OUTCOME.HELD_BY_ANOTHER,
        holder: 'claude-code',
        machine: '0dc8ce0c-1a21-4fd5-8bfb-eb70eb3d52f8',
        path: 'src/billing.ts',
        message: 'held',
      }),
    });
    const watcher = new EditWatcher('/home', world);

    expect(await watcher.handle('/repo', 'src/billing.ts')).toBe(WATCH_OUTCOME.COLLIDED);
    await watcher.handle('/repo', 'src/billing.ts');

    expect(world.said).toEqual([
      'claude-code on 0dc8ce0c was already editing src/billing.ts, and a change saved here overlaps it. Agree who keeps it before either of you pushes.',
    ]);
  });

  /* A build that rewrites a thousand files must not become a thousand requests. */
  it('caps how many claims one minute makes, and ignores generated folders', async () => {
    const world = seams();
    const watcher = new EditWatcher('/home', world);
    const outcomes = [];
    for (let each = 0; each < 61; each += 1) {
      outcomes.push(await watcher.handle('/repo', `src/f${each}.ts`));
    }

    expect(outcomes.filter((each) => each === WATCH_OUTCOME.CLAIMED)).toHaveLength(60);
    expect(outcomes[60]).toBe(WATCH_OUTCOME.DEFERRED);
    expect(worthWatching('node_modules/x/index.js')).toBe(false);
    expect(worthWatching('.git/index')).toBe(false);
    expect(worthWatching('src/billing.ts')).toBe(true);
    /* An editor's scratch files are nobody's work. */
    for (const scratch of [
      'src/.!72772!billing.ts',
      'src/.billing.ts.swp',
      'src/billing.ts~',
      'src/.#billing.ts',
      '4913',
    ]) {
      expect(worthWatching(scratch)).toBe(false);
    }
  });
});
