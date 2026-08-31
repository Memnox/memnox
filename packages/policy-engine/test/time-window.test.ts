import { describe, expect, it } from 'vitest';
import { DECISION_EFFECT } from '@memnox/core';
import { PolicyEngine } from '../src/policy-engine';
import { isValidTimeWindow, matchesTimeWindow } from '../src/time-window';
import type { Policy } from '../src/policy';

const at = (iso: string): Date => new Date(iso);

// 2026-07-27 is a Monday; 2026-08-01 is a Saturday.
const MONDAY_10AM = at('2026-07-27T10:00:00.000Z');
const MONDAY_11PM = at('2026-07-27T23:00:00.000Z');
const SATURDAY_10AM = at('2026-08-01T10:00:00.000Z');

describe('matchesTimeWindow', () => {
  const businessHours = { days: [1, 2, 3, 4, 5], startHour: 9, endHour: 17 };

  it('matches inside the window on an included day', () => {
    expect(matchesTimeWindow(businessHours, MONDAY_10AM)).toBe(true);
  });

  it('rejects the right day at the wrong hour', () => {
    expect(matchesTimeWindow(businessHours, MONDAY_11PM)).toBe(false);
  });

  it('rejects the right hour on the wrong day', () => {
    expect(matchesTimeWindow(businessHours, SATURDAY_10AM)).toBe(false);
  });

  it('treats the end hour as exclusive and the start as inclusive', () => {
    expect(matchesTimeWindow(businessHours, at('2026-07-27T09:00:00.000Z'))).toBe(true);
    expect(matchesTimeWindow(businessHours, at('2026-07-27T17:00:00.000Z'))).toBe(false);
  });

  it('matches every day when days are omitted', () => {
    const anyDay = { startHour: 9, endHour: 17 };
    expect(matchesTimeWindow(anyDay, SATURDAY_10AM)).toBe(true);
  });

  it('handles a window that wraps past midnight', () => {
    const overnight = { startHour: 22, endHour: 6 };
    expect(matchesTimeWindow(overnight, at('2026-07-27T23:30:00.000Z'))).toBe(true);
    expect(matchesTimeWindow(overnight, at('2026-07-28T02:00:00.000Z'))).toBe(true);
    expect(matchesTimeWindow(overnight, at('2026-07-28T12:00:00.000Z'))).toBe(false);
  });

  it('attributes an overnight window to the day it started on', () => {
    // Friday night into Saturday morning still counts as Friday.
    const fridayNight = { days: [5], startHour: 22, endHour: 6 };
    expect(matchesTimeWindow(fridayNight, at('2026-07-31T23:00:00.000Z'))).toBe(true);
    expect(matchesTimeWindow(fridayNight, at('2026-08-01T02:00:00.000Z'))).toBe(true);
  });

  it('shifts by the configured UTC offset', () => {
    const tokyoMorning = { startHour: 9, endHour: 17, utcOffsetMinutes: 9 * 60 };
    expect(matchesTimeWindow(tokyoMorning, at('2026-07-27T01:00:00.000Z'))).toBe(true);
    expect(matchesTimeWindow(tokyoMorning, at('2026-07-27T10:00:00.000Z'))).toBe(false);
  });
});

describe('isValidTimeWindow', () => {
  it('accepts a well-formed window', () => {
    expect(isValidTimeWindow({ startHour: 0, endHour: 24 })).toBe(true);
    expect(isValidTimeWindow({ days: [0, 6], startHour: 9, endHour: 17 })).toBe(true);
  });

  it('rejects out-of-range hours and days', () => {
    expect(isValidTimeWindow({ startHour: -1, endHour: 17 })).toBe(false);
    expect(isValidTimeWindow({ startHour: 9, endHour: 25 })).toBe(false);
    expect(isValidTimeWindow({ startHour: 9, endHour: 0 })).toBe(false);
    expect(isValidTimeWindow({ days: [7], startHour: 9, endHour: 17 })).toBe(false);
    expect(isValidTimeWindow({ days: [], startHour: 9, endHour: 17 })).toBe(false);
  });
});

describe('time-scoped policies', () => {
  const outsideBusinessHours: Policy = {
    name: 'deploy-outside-hours-needs-approval',
    match: {
      actions: ['deploy.service'],
      windows: [
        { days: [1, 2, 3, 4, 5], startHour: 17, endHour: 9 },
        { days: [0, 6], startHour: 0, endHour: 24 },
      ],
    },
    decision: { effect: DECISION_EFFECT.ESCALATE, approvers: ['on-call'] },
  };

  const engine = new PolicyEngine([outsideBusinessHours]);
  const evaluate = (now: Date) =>
    engine.evaluate({ action: 'deploy.service' }, { agentName: 'ci', now });

  it('allows a weekday deploy during business hours', () => {
    expect(evaluate(MONDAY_10AM).effect).toBe(DECISION_EFFECT.ALLOW);
  });

  it('requires approval for a weeknight deploy', () => {
    expect(evaluate(MONDAY_11PM).effect).toBe(DECISION_EFFECT.ESCALATE);
  });

  it('requires approval all weekend', () => {
    expect(evaluate(SATURDAY_10AM).effect).toBe(DECISION_EFFECT.ESCALATE);
  });

  it('is reproducible — the same instant always gives the same verdict', () => {
    expect(evaluate(MONDAY_11PM).effect).toBe(evaluate(MONDAY_11PM).effect);
  });

  it('applies the restriction when no instant is supplied', () => {
    const withoutTime = engine.evaluate(
      { action: 'deploy.service' },
      { agentName: 'ci' },
    );
    expect(withoutTime.effect).toBe(DECISION_EFFECT.ESCALATE);
  });
});
