import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DECISION_EFFECT,
  LEASE_ANSWER,
  LeaseGate,
  LeaseRegistry,
  type ActionRequest,
  type LeaseHolder,
} from '@memnox/core';
import type { HookAuthorizer } from '../src/hook-authorizer';
import { ShellSeam, SHELL_EXIT_OK, SHELL_EXIT_WITHHELD } from '../src/shell-seam';

const ROOT = '/work/repo';
const NOW = '2026-09-05T10:00:00.000Z';
const cursor: LeaseHolder = { agent: 'cursor', sessionId: 'ses_1', pid: 111 };
const claude: LeaseHolder = { agent: 'claude-code', sessionId: 'ses_2', pid: 222 };

const allowing = {
  async authorize(_request: ActionRequest) {
    return { effect: DECISION_EFFECT.ALLOW, reason: 'no rule matched' };
  },
} as unknown as HookAuthorizer;

const home = (): Promise<string> => mkdtemp(join(tmpdir(), 'memnox-shell-lease-'));
const directories = (path: string): boolean => !path.includes('.');

const seamFor = (
  registry: LeaseRegistry,
  holder: LeaseHolder,
  answer?: { answer: string; reason?: string },
): ShellSeam =>
  new ShellSeam({
    authorizer: allowing,
    workingDirectory: ROOT,
    leases: {
      gate: new LeaseGate({
        registry,
        now: () => NOW,
        sleep: async () => undefined,
        ceilingMs: 10,
        pollMs: 5,
        ...(answer === undefined ? {} : { prompt: { ask: async () => answer as never } }),
      }),
      holder,
      repositoryRoot: ROOT,
      isDirectory: directories,
    },
  });

describe('taking a lease where the write happens', () => {
  it('takes the directory a destructive command acts on', async () => {
    const registry = new LeaseRegistry(await home(), () => true);
    const outcome = await seamFor(registry, cursor).gate([
      'rm',
      '-rf',
      '/work/repo/src/billing/old.ts',
    ]);

    expect(outcome.exitCode).toBe(SHELL_EXIT_OK);
    const held = await registry.held(NOW);
    expect(held.map((lease) => lease.path)).toEqual(['src/billing']);
  });

  it('never takes one for a read, so nothing here can make a reader wait', async () => {
    const registry = new LeaseRegistry(await home(), () => true);
    const outcome = await seamFor(registry, cursor).gate([
      'cat',
      '/work/repo/src/billing/invoice.ts',
    ]);

    expect(outcome.exitCode).toBe(SHELL_EXIT_OK);
    expect(await registry.held(NOW)).toEqual([]);
  });

  it('takes nothing for a path outside the repository', async () => {
    const registry = new LeaseRegistry(await home(), () => true);
    await seamFor(registry, cursor).gate(['rm', '-rf', '/tmp/scratch']);
    expect(await registry.held(NOW)).toEqual([]);
  });

  it('holds one lease for a session writing across the same directory', async () => {
    const registry = new LeaseRegistry(await home(), () => true);
    const seam = seamFor(registry, cursor);
    await seam.gate(['rm', '-rf', '/work/repo/src/billing/a.ts']);
    await seam.gate(['rm', '-rf', '/work/repo/src/billing/b.ts']);

    expect(await registry.held(NOW)).toHaveLength(1);
  });

  it('withholds the command when another agent holds the path, and names them', async () => {
    const where = await home();
    const registry = new LeaseRegistry(where, () => true);
    await registry.take('src/billing', cursor, NOW, 60, 'wrote invoice.ts');

    const outcome = await seamFor(registry, claude).gate([
      'rm',
      '-rf',
      '/work/repo/src/billing/old.ts',
    ]);

    expect(outcome.exitCode).toBe(SHELL_EXIT_WITHHELD);
    expect(outcome.run).toBeUndefined();
    expect(outcome.message).toContain('cursor');
  });

  it('runs the command once the holder is overruled, on the record', async () => {
    const where = await home();
    const registry = new LeaseRegistry(where, () => true);
    await registry.take('src/billing', cursor, NOW, 60, 'wrote invoice.ts');

    const outcome = await seamFor(registry, claude, {
      answer: LEASE_ANSWER.TAKE,
      reason: 'the build is red',
    }).gate(['rm', '-rf', '/work/repo/src/billing/old.ts']);

    expect(outcome.exitCode).toBe(SHELL_EXIT_OK);
    const overruled = (await registry.all()).find(
      (lease) => lease.takenOver !== undefined,
    );
    expect(overruled?.takenOver?.reason).toBe('the build is red');
  });

  it('costs a machine with one agent nothing, because no register is wired', async () => {
    const outcome = await new ShellSeam({ authorizer: allowing }).gate([
      'rm',
      '-rf',
      './build',
    ]);
    expect(outcome.exitCode).toBe(SHELL_EXIT_OK);
  });
});
