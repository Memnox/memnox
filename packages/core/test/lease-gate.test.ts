import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LEASE_ANSWER,
  LEASE_GATE,
  LeaseGate,
  proceeds,
  type LeaseAsked,
  type LeasePrompt,
} from '../src/coordination/lease-gate';
import { LeaseRegistry } from '../src/coordination/lease-store';
import type { Lease, LeaseHolder } from '../src/coordination/lease';
import {
  CloudLeases,
  SHARED_OUTCOME,
  type SharedLeases,
} from '../src/coordination/shared-leases';

const START = Date.parse('2026-09-05T10:00:00.000Z');
const cursor: LeaseHolder = { agent: 'cursor', sessionId: 'ses_1', pid: 111 };
const claude: LeaseHolder = { agent: 'claude-code', sessionId: 'ses_2', pid: 222 };

const home = (): Promise<string> => mkdtemp(join(tmpdir(), 'memnox-gate-'));

/** A clock the test moves, so a bounded wait is proven rather than waited through. */
class Clock {
  private ms = START;
  now = (): string => new Date(this.ms).toISOString();
  sleep = async (by: number): Promise<void> => {
    this.ms += by;
  };
  advance(ms: number): void {
    this.ms += ms;
  }
}

const answering = (asked: LeaseAsked | null): LeasePrompt => ({
  ask: async () => asked,
});

describe('nobody in the way', () => {
  it('takes the path and gets out of the way', async () => {
    const clock = new Clock();
    const gate = new LeaseGate({
      registry: new LeaseRegistry(await home(), () => true),
      now: clock.now,
      sleep: clock.sleep,
    });

    const verdict = await gate.claim('src/billing', cursor, 'wrote invoice.ts');
    expect(verdict.outcome).toBe(LEASE_GATE.TAKEN);
    expect(proceeds(verdict)).toBe(true);
  });
});

describe('somebody in the way', () => {
  const held = async (): Promise<{ registry: LeaseRegistry; clock: Clock }> => {
    const clock = new Clock();
    const registry = new LeaseRegistry(await home(), () => true);
    await registry.take('src/billing', cursor, clock.now(), 60, 'wrote invoice.ts');
    return { registry, clock };
  };

  it('waits, then proceeds when the holder lets go inside the window', async () => {
    const { registry, clock } = await held();
    const [standing] = await registry.held(clock.now());

    const gate = new LeaseGate({
      registry,
      prompt: answering({ answer: LEASE_ANSWER.WAIT }),
      now: clock.now,
      sleep: async (ms) => {
        await clock.sleep(ms);
        // The holder finishes while the waiter is asleep, which is the ordinary case.
        await registry.release(standing?.id ?? '', cursor, clock.now());
      },
      pollMs: 100,
    });

    const verdict = await gate.claim('src/billing/tax.ts', claude, 'wrote tax.ts');
    expect(verdict.outcome).toBe(LEASE_GATE.WAITED);
    expect(proceeds(verdict)).toBe(true);
  });

  it('gives up on a bounded wait, and names the holder when it does', async () => {
    const { registry, clock } = await held();
    const gate = new LeaseGate({
      registry,
      prompt: answering({ answer: LEASE_ANSWER.WAIT }),
      now: clock.now,
      sleep: clock.sleep,
      ceilingMs: 2_000,
      pollMs: 250,
    });

    const verdict = await gate.claim('src/billing', claude, 'refactoring');
    expect(verdict.outcome).toBe(LEASE_GATE.TIMED_OUT);
    expect(proceeds(verdict)).toBe(false);
    // A refusal nobody can act on is one people work around by forcing every time.
    expect(verdict.message).toContain('cursor');
  });

  it('never waits past the lease that is in the way', async () => {
    const { registry, clock } = await held();
    const gate = new LeaseGate({
      registry,
      prompt: answering({ answer: LEASE_ANSWER.WAIT }),
      now: clock.now,
      sleep: clock.sleep,
      ceilingMs: 10 * 60_000,
      pollMs: 60_000,
    });

    const before = Date.parse(clock.now());
    await gate.claim('src/billing', claude, 'refactoring');
    // The holder's own hour was longer than the ceiling, so the ceiling is what bound it.
    expect(Date.parse(clock.now()) - before).toBeLessThanOrEqual(10 * 60_000 + 60_000);
  });

  it('stands down when the writer refuses', async () => {
    const { registry, clock } = await held();
    const gate = new LeaseGate({
      registry,
      prompt: answering({ answer: LEASE_ANSWER.REFUSE }),
      now: clock.now,
      sleep: clock.sleep,
    });

    const verdict = await gate.claim('src/billing', claude, 'refactoring');
    expect(verdict.outcome).toBe(LEASE_GATE.REFUSED);
    expect(verdict.message).toContain('cursor');
  });

  it('takes it anyway, and leaves the reason in the record', async () => {
    const { registry, clock } = await held();
    const gate = new LeaseGate({
      registry,
      prompt: answering({ answer: LEASE_ANSWER.TAKE, reason: 'the build is red' }),
      now: clock.now,
      sleep: clock.sleep,
    });

    const verdict = await gate.claim('src/billing', claude, 'fixing the build');
    expect(verdict.outcome).toBe(LEASE_GATE.TOOK_OVER);

    const taken = (await registry.all()).find(
      (lease: Lease) => lease.takenOver !== undefined,
    );
    expect(taken?.takenOver?.reason).toBe('the build is red');
    expect(taken?.takenOver?.by.agent).toBe('claude-code');

    const now = await registry.held(clock.now());
    expect(now.map((lease) => lease.holder.agent)).toEqual(['claude-code']);
  });

  it('refuses a takeover with no reason, rather than recording a blank one', async () => {
    const { registry, clock } = await held();
    const gate = new LeaseGate({
      registry,
      prompt: answering({ answer: LEASE_ANSWER.TAKE, reason: '   ' }),
      now: clock.now,
      sleep: clock.sleep,
    });

    const verdict = await gate.claim('src/billing', claude, 'fixing the build');
    expect(verdict.outcome).toBe(LEASE_GATE.REFUSED);
    expect(verdict.message).toContain('reason');
  });

  it('waits it out when there is nobody to ask, rather than hanging', async () => {
    const { registry, clock } = await held();
    const gate = new LeaseGate({
      registry,
      now: clock.now,
      sleep: clock.sleep,
      ceilingMs: 1_000,
      pollMs: 250,
    });

    expect((await gate.claim('src/billing', claude, 'refactoring')).outcome).toBe(
      LEASE_GATE.TIMED_OUT,
    );
  });

  it('never makes a session wait on itself', async () => {
    const { registry, clock } = await held();
    const gate = new LeaseGate({ registry, now: clock.now, sleep: clock.sleep });
    const verdict = await gate.claim('src/billing/tax.ts', cursor, 'wrote tax.ts');
    expect(verdict.outcome).toBe(LEASE_GATE.TAKEN);
  });
});

describe('a wait cannot become a hang', () => {
  it('gives up even when the clock never advances', async () => {
    const registry = new LeaseRegistry(await home(), () => true);
    const frozen = '2026-09-05T10:00:00.000Z';
    await registry.take('src/billing', cursor, frozen, 60, 'wrote invoice.ts');

    const gate = new LeaseGate({
      registry,
      now: () => frozen,
      /* Neither the clock nor the sleep moves, which is the shape a stubbed environment
         and a suspended machine both have. It still has to end. */
      sleep: async () => undefined,
      ceilingMs: 5_000,
      pollMs: 100,
    });

    expect((await gate.claim('src/billing', claude, 'refactoring')).outcome).toBe(
      LEASE_GATE.TIMED_OUT,
    );
  }, 5_000);
});

describe('two machines on one repository', () => {
  const workspace = (result: unknown): SharedLeases => ({
    take: async () => result as never,
    release: async () => undefined,
  });

  it('refuses when another machine holds it, and names where', async () => {
    const clock = new Clock();
    const gate = new LeaseGate({
      registry: new LeaseRegistry(await home(), () => true),
      shared: workspace({
        outcome: SHARED_OUTCOME.HELD_BY_ANOTHER,
        holder: 'hermes',
        machine: 'vps-1',
        path: 'src/billing',
        message: 'wait for it, or take it over and say why',
      }),
      now: clock.now,
      sleep: clock.sleep,
    });

    const verdict = await gate.claim('src/billing', cursor, 'refactoring');
    expect(proceeds(verdict)).toBe(false);
    expect(verdict.message).toContain('hermes');
    expect(verdict.message).toContain('vps-1');
  });

  it('gives the local lease back rather than holding what it may not write', async () => {
    const clock = new Clock();
    const registry = new LeaseRegistry(await home(), () => true);
    const gate = new LeaseGate({
      registry,
      shared: workspace({
        outcome: SHARED_OUTCOME.HELD_BY_ANOTHER,
        holder: 'hermes',
        path: 'src/billing',
        message: 'held elsewhere',
      }),
      now: clock.now,
      sleep: clock.sleep,
    });

    await gate.claim('src/billing', cursor, 'refactoring');
    // A local register that still shows a path this session lost is a stale register.
    expect(await registry.held(clock.now())).toEqual([]);
  });

  /* A lease is coordination and not safety. One that blocked work whenever the
     network hiccuped is one people would turn off inside a day. */
  it('proceeds when the control plane cannot be reached', async () => {
    const clock = new Clock();
    const gate = new LeaseGate({
      registry: new LeaseRegistry(await home(), () => true),
      shared: workspace({
        outcome: SHARED_OUTCOME.UNKNOWN,
        because: 'the control plane did not answer',
      }),
      now: clock.now,
      sleep: clock.sleep,
    });

    expect((await gate.claim('src/billing', cursor, 'writing')).outcome).toBe(
      LEASE_GATE.TAKEN,
    );
  });

  it('proceeds when the workspace says the path is free', async () => {
    const clock = new Clock();
    const gate = new LeaseGate({
      registry: new LeaseRegistry(await home(), () => true),
      shared: workspace({ outcome: SHARED_OUTCOME.TAKEN, lease: {} }),
      now: clock.now,
      sleep: clock.sleep,
    });

    expect((await gate.claim('src/billing', cursor, 'writing')).outcome).toBe(
      LEASE_GATE.TAKEN,
    );
  });

  /* The promise on the front page: with no account file nothing here touches the
     network at all. One check, not a flag somewhere. */
  it('makes no network call at all for a machine with no account', async () => {
    let called = 0;
    const fetcher = (async () => {
      called += 1;
      throw new Error('a machine with no account must not call anything');
    }) as unknown as typeof globalThis.fetch;

    const leases = new CloudLeases(await home(), fetcher);
    const result = await leases.take('src/billing', cursor, 30);

    expect(called).toBe(0);
    expect(result.outcome).toBe(SHARED_OUTCOME.UNKNOWN);
  });
});
