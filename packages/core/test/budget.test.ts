import { describe, expect, it } from 'vitest';
import {
  ACTOR_TYPE,
  DECISION_EFFECT,
  ENFORCEMENT_MODE,
  EVENT_SCHEMA_VERSION,
  EVENT_SURFACE,
  TOOL_CLASS,
  type MemnoxEvent,
} from '../src/index';
import {
  BUDGET_UNIT,
  BUDGET_WINDOW,
  coversAction,
  describeSpend,
  elsewhere,
  fleetBudgets,
  windowHoursOf,
  exhaustedBy,
  spendReport,
  spentOn,
  validateBudget,
  type Budget,
} from '../src/session/budget';
import { suggestedBudgets } from '../src/session/budget-store';

const NOW = '2026-09-05T10:00:00.000Z';
const ago = (minutes: number): string =>
  new Date(Date.parse(NOW) - minutes * 60_000).toISOString();

const deploys: Budget = {
  name: 'production deploys',
  actions: ['deploy.*'],
  limit: 3,
  window: BUDGET_WINDOW.DAY,
  unit: BUDGET_UNIT.CALLS,
};

const event = (over: Partial<MemnoxEvent> = {}): MemnoxEvent => ({
  id: `evt_${Math.random().toString(36).slice(2, 10)}`,
  schemaVersion: EVENT_SCHEMA_VERSION,
  at: NOW,
  sessionId: 'ses_1',
  agent: 'claude-code',
  actorType: ACTOR_TYPE.AGENT,
  surface: EVENT_SURFACE.SHELL,
  operation: 'deploy.service',
  class: TOOL_CLASS.WRITE,
  effect: DECISION_EFFECT.ALLOW,
  mode: ENFORCEMENT_MODE.ENFORCE,
  reason: 'ok',
  ...over,
});

const times = (n: number, over: Partial<MemnoxEvent> = {}): MemnoxEvent[] =>
  Array.from({ length: n }, () => event(over));

describe('what a budget counts', () => {
  it('counts what actually ran', () => {
    expect(spentOn(deploys, times(2), NOW)).toBe(2);
  });

  /* A denied action never reached a terminal, so charging for it would let a strict
     policy exhaust the very budget it was protecting. */
  it('never counts what was refused', () => {
    expect(spentOn(deploys, times(5, { effect: DECISION_EFFECT.DENY }), NOW)).toBe(0);
  });

  it('counts only what the patterns cover', () => {
    expect(spentOn(deploys, times(3, { operation: 'git.status' }), NOW)).toBe(0);
    expect(coversAction(deploys, 'deploy.service')).toBe(true);
    expect(coversAction(deploys, 'git.push')).toBe(false);
  });

  it('forgets what fell out of the window', () => {
    const old = times(5, { at: ago(60 * 25) });
    expect(spentOn(deploys, [...old, event()], NOW)).toBe(1);
  });

  it('counts a session budget against one session and not the machine', () => {
    const session: Budget = { ...deploys, window: BUDGET_WINDOW.SESSION };
    const mixed = [...times(2), ...times(3, { sessionId: 'ses_other' })];
    expect(spentOn(session, mixed, NOW, 'ses_1')).toBe(2);
  });
});

describe('running out is not a refusal of the action', () => {
  it('lets the action through while there is allowance left', () => {
    expect(exhaustedBy([deploys], 'deploy.service', times(2), NOW)).toBeNull();
  });

  it('stops the one that would go past the limit, not the one after it', () => {
    const breach = exhaustedBy([deploys], 'deploy.service', times(3), NOW);
    expect(breach).not.toBeNull();
    // Named as an allowance, because that leads to a different fix than a rule does.
    expect(breach?.reason).toContain('none left');
    expect(breach?.reason).toContain('3 of 3');
  });

  it('says nothing about an action no budget covers', () => {
    expect(exhaustedBy([deploys], 'git.status', times(99), NOW)).toBeNull();
  });
});

describe('dollars are only ever counted from a reported cost', () => {
  const spend: Budget = {
    name: 'model spend',
    actions: ['*'],
    limit: 10,
    window: BUDGET_WINDOW.DAY,
    unit: BUDGET_UNIT.USD,
  };

  /* This machine sees a command run and has no idea what the model behind it charged.
     A local guess at a price would be a number somebody would act on. */
  it('counts nothing when nothing can price an event', () => {
    expect(spentOn(spend, times(100), NOW)).toBe(0);
    expect(exhaustedBy([spend], 'anything', times(100), NOW)).toBeNull();
  });

  it('counts what a pricer reports', () => {
    const priced = spentOn(spend, times(4), NOW, undefined, () => 3);
    expect(priced).toBe(12);
  });
});

describe('reporting', () => {
  it('says what is left, never below zero', () => {
    const [report] = spendReport([deploys], times(5), NOW);
    expect(report?.spent).toBe(5);
    expect(report?.remaining).toBe(0);
    expect(describeSpend(report!)).toContain('5 / 3');
  });

  it('refuses a budget of zero, because that is a deny rule', () => {
    expect(validateBudget({ name: 'x', actions: ['a'], limit: 0 }).join(' ')).toContain(
      'deny rule',
    );
  });

  it('refuses one that names no actions', () => {
    expect(validateBudget({ name: 'x', limit: 5 }).join(' ')).toContain('actions');
  });

  /* Deliberately far above a normal day: a budget that bites in week one gets deleted,
     and then nothing is watching when the runaway actually happens. */
  it('suggests numbers only a runaway reaches', () => {
    const suggested = suggestedBudgets();
    expect(suggested.length).toBeGreaterThan(0);
    for (const each of suggested) {
      expect(validateBudget(each)).toEqual([]);
      expect(each.limit).toBeGreaterThanOrEqual(5);
    }
  });
});

describe('a budget counted across a fleet', () => {
  const fleetDeploys: Budget = { ...deploys, fleet: true };

  /* Three VPSs each allowed twenty pull requests a day is sixty, which is not what
     anybody set. The count that matters is the workspace's. */
  it('adds what other machines have spent', () => {
    const breach = exhaustedBy(
      [fleetDeploys],
      'deploy.service',
      times(1),
      NOW,
      undefined,
      1,
      undefined,
      [{ name: 'production deploys', spent: 2, at: NOW }],
    );
    expect(breach).not.toBeNull();
    expect(breach?.reason).toContain('3 of 3');
  });

  it('leaves a machine budget counting only this machine', () => {
    expect(
      exhaustedBy([deploys], 'deploy.service', times(1), NOW, undefined, 1, undefined, [
        { name: 'production deploys', spent: 99, at: NOW },
      ]),
    ).toBeNull();
  });

  /* An unreachable control plane degrades a fleet budget to a machine budget, never
     to no budget: the machine still enforces what it can see itself. */
  it('falls back to this machine when nobody could be counted', () => {
    expect(
      exhaustedBy(
        [fleetDeploys],
        'deploy.service',
        times(1),
        NOW,
        undefined,
        1,
        undefined,
        [],
      ),
    ).toBeNull();
    expect(
      exhaustedBy(
        [fleetDeploys],
        'deploy.service',
        times(3),
        NOW,
        undefined,
        1,
        undefined,
        [],
      ),
    ).not.toBeNull();
  });

  it('asks the workspace only about the budgets counted there', () => {
    expect(fleetBudgets([deploys, fleetDeploys]).map((each) => each.name)).toEqual([
      'production deploys',
    ]);
  });

  it('turns a window into hours, and says a session cannot be counted across a fleet', () => {
    expect(windowHoursOf(fleetDeploys)).toBe(24);
    expect(windowHoursOf({ ...fleetDeploys, window: BUDGET_WINDOW.HOUR })).toBe(1);
    expect(windowHoursOf({ ...fleetDeploys, window: BUDGET_WINDOW.SESSION })).toBe(0);
  });

  it('ignores a total that is about a different budget', () => {
    expect(
      elsewhere(fleetDeploys, [{ name: 'something else', spent: 99, at: NOW }]),
    ).toBe(0);
  });
});
