import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIMITS,
  LIMIT,
  REPEATED_VIOLATION_THRESHOLD,
  SessionLimits,
  ViolationMemory,
} from '../src/daemon/limits';

const START = '2026-09-05T10:00:00.000Z';
const later = (minutes: number): string =>
  new Date(Date.parse(START) + minutes * 60_000).toISOString();

describe('session limits', () => {
  it('counts tool calls and stops past the ceiling', () => {
    const limits = new SessionLimits({ ...DEFAULT_LIMITS, toolCalls: 3 });
    limits.start('ses_1', START);

    for (let n = 0; n < 3; n += 1) {
      expect(limits.record('ses_1', `call${n}`, START)).toBeNull();
    }
    const breach = limits.record('ses_1', 'call4', START);
    expect(breach?.kind).toBe(LIMIT.TOOL_CALLS);
    expect(breach?.reason).toContain('past the 3 you allow');
  });

  it('catches the same action running in a loop', () => {
    const limits = new SessionLimits({ ...DEFAULT_LIMITS, repeatedAction: 2 });
    limits.start('ses_1', START);

    limits.record('ses_1', 'same', START);
    limits.record('ses_1', 'same', START);
    const breach = limits.record('ses_1', 'same', START);

    expect(breach?.kind).toBe(LIMIT.REPEATED_ACTION);
    expect(breach?.reason).toContain('a loop rather than work');
  });

  it('does not count different actions towards a loop', () => {
    const limits = new SessionLimits({ ...DEFAULT_LIMITS, repeatedAction: 2 });
    limits.start('ses_1', START);
    expect(limits.record('ses_1', 'a', START)).toBeNull();
    expect(limits.record('ses_1', 'b', START)).toBeNull();
    expect(limits.record('ses_1', 'c', START)).toBeNull();
  });

  it('ends a session that has been running too long, on the moment it is given', () => {
    const limits = new SessionLimits({ ...DEFAULT_LIMITS, runtimeMinutes: 60 });
    limits.start('ses_1', START);

    expect(limits.record('ses_1', 'x', later(30))).toBeNull();
    const breach = limits.record('ses_1', 'y', later(61));
    expect(breach?.kind).toBe(LIMIT.RUNTIME);
    expect(breach?.reached).toBe(61);
  });

  it('never reads a clock, so the same inputs give the same answer', () => {
    const a = new SessionLimits({ ...DEFAULT_LIMITS, runtimeMinutes: 1 });
    const b = new SessionLimits({ ...DEFAULT_LIMITS, runtimeMinutes: 1 });
    a.start('s', START);
    b.start('s', START);
    expect(a.record('s', 'x', later(5))).toEqual(b.record('s', 'x', later(5)));
  });

  it('treats zero as no limit at all', () => {
    const limits = new SessionLimits({
      runtimeMinutes: 0,
      toolCalls: 0,
      repeatedAction: 0,
    });
    limits.start('ses_1', START);
    for (let n = 0; n < 50; n += 1) {
      expect(limits.record('ses_1', 'same', later(10_000))).toBeNull();
    }
  });

  it('starts a session it was never told about, rather than losing the count', () => {
    const limits = new SessionLimits({ ...DEFAULT_LIMITS, toolCalls: 1 });
    expect(limits.record('unknown', 'x', START)).toBeNull();
    expect(limits.counts('unknown')?.toolCalls).toBe(1);
  });

  it('forgets a session when it ends', () => {
    const limits = new SessionLimits();
    limits.start('ses_1', START);
    limits.end('ses_1');
    expect(limits.counts('ses_1')).toBeNull();
  });
});

describe('repeated violations', () => {
  it('remembers every previous attempt at the same thing', () => {
    const memory = new ViolationMemory();
    memory.record({ action: 'git.push', target: 'main', at: START });
    memory.record({ action: 'git.push', target: 'main', at: later(5) });

    expect(memory.history('git.push', 'main')).toHaveLength(2);
    expect(memory.history('git.push', 'other')).toHaveLength(0);
  });

  it('calls it repeated on the third try, not the second', () => {
    const memory = new ViolationMemory();
    expect(REPEATED_VIOLATION_THRESHOLD).toBe(3);

    memory.record({ action: 'a', at: START });
    memory.record({ action: 'a', at: START });
    expect(memory.isRepeated('a')).toBe(false);

    memory.record({ action: 'a', at: START });
    expect(memory.isRepeated('a')).toBe(true);
  });
});
