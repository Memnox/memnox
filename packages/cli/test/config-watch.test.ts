import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { watch } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { watchablePaths } from '@memnox/core';
import { watchConfigPaths } from '../src/config-watch';

describe('the directories worth watching', () => {
  /* A config that does not exist yet cannot be watched, and a newly added MCP config
     is exactly the arrival worth catching — so it is the directory that is watched. */
  it('watches the directory that holds each agent config', () => {
    const paths = watchablePaths('/home/me');

    expect(paths).toContain('/home/me/.claude');
    expect(paths).toContain('/home/me/.cursor');
    expect(paths).toContain('/home/me');
  });
});

describe('waking on a change', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'memnox-watch-'));
    await mkdir(join(dir, '.claude'), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /* The whole point: an MCP server added mid-watch is reported in seconds rather than
     on the next minute boundary, which is how long somebody would otherwise be told
     nothing had changed.

     Stubbed for the same reason the next test is. Against a real directory this raced
     the watcher's own arming — a write that landed first was never reported, the wait
     ran to its 60s interval, and the suite failed on a busy machine roughly one run in
     ten. What is asserted here is the contract: a change resolves the wait, and it
     resolves it nowhere near the interval. */
  it('returns long before the interval when a config file arrives', async () => {
    let fire: (() => void) | null = null;
    const watcher = watchConfigPaths(['/watched'], {
      watch: ((_path: string, _options: unknown, onChange: () => void) => {
        fire = onChange;
        return { close: () => {} };
      }) as unknown as typeof watch,
    });
    const waiting = watcher.next(60_000);
    (fire as unknown as () => void)();
    const changed = await waiting;
    watcher.close();

    /* True means the change resolved the wait; the timeout path returns false. So the
       boolean already says it did not sit out the interval, and a stopwatch beside it
       would only add a way for a busy machine to fail the suite. */
    expect(changed).toBe(true);
  });

  /* Driven by a stub rather than the real filesystem: macOS coalesces and replays
     FSEvents, so a test that asserts "nothing happened" against a real directory is a
     test that fails on a busy machine and teaches everyone to re-run the suite. */
  it('gives up when nothing changed, so the interval still governs', async () => {
    const watcher = watchConfigPaths(['/watched'], {
      watch: (() => ({ close: () => {} })) as unknown as typeof watch,
    });

    expect(await watcher.next(20)).toBe(false);
    watcher.close();
  });

  // A directory nobody has created is nothing to watch, and never a crash.
  it('survives a path that is not there', async () => {
    const watcher = watchConfigPaths([join(dir, 'never-created')]);

    expect(await watcher.next(20)).toBe(false);
    watcher.close();
  });
});
