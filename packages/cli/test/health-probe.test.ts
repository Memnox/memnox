import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gatherHealth } from '../src/health-probe';

const home = (): Promise<string> => mkdtemp(join(tmpdir(), 'memnox-probe-'));

describe('what the doctor expects to be wrapped', () => {
  /* `protect --interceptors` wraps only what is installed and says so. Expecting the
     rest made `doctor` report a fault whose own suggested fix could never clear it,
     which sends somebody round the same two commands until they believe neither. */
  it('expects nothing on a machine with none of the binaries', async () => {
    const facts = await gatherHealth(await home(), await home(), { PATH: '' });
    expect(facts.interceptorsExpected).toEqual([]);
  });

  it('expects only what is actually on PATH', async () => {
    const facts = await gatherHealth(await home(), await home(), {
      PATH: '/usr/bin:/bin',
    });
    // git is on every machine this runs on; terraform is not on most.
    expect(facts.interceptorsExpected).toContain('git');
    expect(facts.interceptorsExpected.length).toBeLessThan(20);
  });

  it('reports nothing held on a machine that has never run an agent', async () => {
    const facts = await gatherHealth(await home(), await home(), { PATH: '' });
    expect(facts.pausedSessions).toBe(0);
    expect(facts.waitingApprovals).toBe(0);
    expect(facts.heldLeases).toBe(0);
    expect(facts.spentBudgets).toEqual([]);
  });
});
