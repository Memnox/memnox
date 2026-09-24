import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readHealth } from '../src/health-probe';

const home = (): Promise<string> => mkdtemp(join(tmpdir(), 'memnox-probe-'));

describe('what the doctor expects to be wrapped', () => {
  /* `protect --interceptors` wraps only what is installed and says so. Expecting the
     rest made `doctor` report a fault whose own suggested fix could never clear it,
     which sends somebody round the same two commands until they believe neither. */
  it('expects nothing on a machine with none of the binaries', async () => {
    const facts = await readHealth(await home(), await home(), { PATH: '' });
    expect(facts.interceptorsExpected).toEqual([]);
  });

  it('expects only what is actually on PATH', async () => {
    const facts = await readHealth(await home(), await home(), {
      PATH: '/usr/bin:/bin',
    });
    // git is on every machine this runs on; terraform is not on most.
    expect(facts.interceptorsExpected).toContain('git');
    expect(facts.interceptorsExpected.length).toBeLessThan(20);
  });

  it('reports nothing held on a machine that has never run an agent', async () => {
    const facts = await readHealth(await home(), await home(), { PATH: '' });
    expect(facts.pausedSessions).toBe(0);
    expect(facts.waitingApprovals).toBe(0);
    expect(facts.heldLeases).toBe(0);
    expect(facts.spentBudgets).toEqual([]);
  });
});

/**
 * The binary every wrapper execs.
 *
 * A wrapper is three lines ending in `exec "memnox-intercept" "git" "$@"`, so the
 * whole directory depends on that name resolving. Asked through `resolveReal` the
 * answer is always "missing": that function refuses this one name on purpose, to
 * stop a wrapper resolving to the interceptor and spawning itself without end. So
 * the probe walks PATH itself, and this is the test that would have caught it
 * reporting all sixteen broken on a machine where they were fine.
 */
describe('whether the interceptor binary can be found', () => {
  it('finds it when a PATH entry holds it', async () => {
    const bin = await mkdtemp(join(tmpdir(), 'memnox-bin-'));
    await writeFile(join(bin, 'memnox-intercept'), '#!/bin/sh\n', { mode: 0o755 });

    const facts = await readHealth(await home(), await home(), { PATH: bin });
    expect(facts.interceptBinaryFound).toBe(true);
  });

  it('says so when no PATH entry holds it', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'memnox-bin-'));
    const facts = await readHealth(await home(), await home(), { PATH: empty });
    expect(facts.interceptBinaryFound).toBe(false);
  });
});
