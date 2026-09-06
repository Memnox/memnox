import { matchesAny } from '../policy/pattern-matcher';
import type { MemnoxEvent } from '../event/event';

/**
 * What an agent may spend in a day, as against what it may do.
 *
 * A permission answers "may this happen"; a budget answers "may this happen again".
 * They are different questions and the second one is the one that catches a loop that
 * every individual call was entitled to make — twenty pull requests are each fine and
 * the twentieth is a sign.
 *
 * Two rules. A budget counts what actually happened, from the ledger, so it survives a
 * restart and cannot be reset by killing a process. And running out is not a denial of
 * the action, it is the end of the day's allowance: the message says so, because those
 * lead to different fixes.
 */

export const BUDGET_WINDOW = {
  DAY: 'day',
  HOUR: 'hour',
  /** One run. Resets when the session does, which is what an overnight task wants. */
  SESSION: 'session',
} as const;

export type BudgetWindow = (typeof BUDGET_WINDOW)[keyof typeof BUDGET_WINDOW];

export const BUDGET_UNIT = {
  CALLS: 'calls',
  /** Dollars, and only ever from a cost something reported. Never estimated here. */
  USD: 'usd',
} as const;

export type BudgetUnit = (typeof BUDGET_UNIT)[keyof typeof BUDGET_UNIT];

export interface Budget {
  /** What a person calls it: "production deploys", "outbound email". */
  name: string;
  /** Action patterns it covers, in the same grammar rules use. */
  actions: string[];
  limit: number;
  window: BudgetWindow;
  unit: BudgetUnit;
  /**
   * Counted across the workspace rather than on this machine alone.
   *
   * A budget counted per machine is a budget multiplied by however many machines
   * there are: three VPSs each allowed twenty pull requests a day is sixty, which is
   * not what anybody set. False by default, because a fleet count needs an account
   * and most machines have none.
   */
  fleet?: boolean;
}

/**
 * What the workspace says has been spent, as of the last heartbeat.
 *
 * A number, not a decision. It is added to what this machine has counted itself, so
 * an unreachable control plane degrades a fleet budget to a machine budget rather
 * than to no budget at all.
 */
export interface FleetSpend {
  name: string;
  spent: number;
  /** When it was last heard. A stale figure is still better than none, and is said. */
  at: string;
}

export interface BudgetSpend {
  budget: Budget;
  spent: number;
  remaining: number;
}

export interface BudgetBreach {
  budget: Budget;
  spent: number;
  reason: string;
}

const WINDOW_MS: Record<BudgetWindow, number> = {
  [BUDGET_WINDOW.HOUR]: 60 * 60_000,
  [BUDGET_WINDOW.DAY]: 24 * 60 * 60_000,
  // A session has no clock window; it is bounded by the session id instead.
  [BUDGET_WINDOW.SESSION]: 0,
};

export function coversAction(budget: Budget, action: string): boolean {
  return matchesAny(budget.actions, action);
}

/** Events inside a budget's window, as of a moment the caller passes in. */
export function windowOf(
  budget: Budget,
  events: readonly MemnoxEvent[],
  now: string,
  sessionId?: string,
): MemnoxEvent[] {
  if (budget.window === BUDGET_WINDOW.SESSION) {
    return sessionId === undefined
      ? []
      : events.filter((event) => event.sessionId === sessionId);
  }
  const cutoff = Date.parse(now) - WINDOW_MS[budget.window];
  return events.filter((event) => Date.parse(event.at) >= cutoff);
}

/**
 * What one event cost. Injected, and zero by default.
 *
 * The ledger records what happened, not what it cost: this machine sees a command run
 * and has no idea what the model behind it charged. So a dollar budget counts only
 * what something able to price it reports — the cloud, or a wrapper that knows the
 * token count. A local guess at a price would be a number somebody would act on.
 */
export type EventCost = (event: MemnoxEvent) => number;

/**
 * What the row says it cost, which is the only figure on this machine that is not a
 * guess. Absent is zero here because a budget counts what was reported; whether
 * anything reported at all is a separate question the screen answers separately.
 */
export const REPORTED_COST: EventCost = (event) => event.costUsd ?? 0;

/**
 * What has been spent, counted from the record.
 *
 * Only what proceeded counts. An action that was denied cost nothing and charging for
 * it would mean a strict policy exhausting the budget it was protecting.
 */
export function spentOn(
  budget: Budget,
  events: readonly MemnoxEvent[],
  now: string,
  sessionId?: string,
  costOf: EventCost = REPORTED_COST,
): number {
  const inWindow = windowOf(budget, events, now, sessionId).filter(
    (event) => coversAction(budget, event.operation) && didHappen(event),
  );
  if (budget.unit === BUDGET_UNIT.CALLS) return inWindow.length;
  return inWindow.reduce((total, event) => total + costOf(event), 0);
}

function didHappen(event: MemnoxEvent): boolean {
  // Denied and held calls never ran, so they never spent anything.
  return event.effect === 'allow';
}

export function spendReport(
  budgets: readonly Budget[],
  events: readonly MemnoxEvent[],
  now: string,
  sessionId?: string,
  costOf?: EventCost,
): BudgetSpend[] {
  return budgets.map((budget) => {
    const spent = spentOn(budget, events, now, sessionId, costOf);
    return { budget, spent, remaining: Math.max(0, budget.limit - spent) };
  });
}

/**
 * The first budget this action would take past its limit, or null.
 *
 * Checked before the action rather than after: a budget that reports being over
 * afterwards has already let the thing happen, which is a receipt and not a control.
 */
export function exhaustedBy(
  budgets: readonly Budget[],
  action: string,
  events: readonly MemnoxEvent[],
  now: string,
  sessionId?: string,
  cost = 1,
  costOf?: EventCost,
  fleet: readonly FleetSpend[] = [],
): BudgetBreach | null {
  for (const budget of budgets) {
    if (!coversAction(budget, action)) continue;
    const spent =
      spentOn(budget, events, now, sessionId, costOf) + elsewhere(budget, fleet);
    const wants = budget.unit === BUDGET_UNIT.USD ? cost : 1;
    if (spent + wants <= budget.limit) continue;
    return {
      budget,
      spent,
      reason: describeBreach(budget, spent),
    };
  }
  return null;
}

function describeBreach(budget: Budget, spent: number): string {
  const amount =
    budget.unit === BUDGET_UNIT.USD
      ? `$${spent.toFixed(2)} of $${budget.limit.toFixed(2)}`
      : `${spent} of ${budget.limit}`;
  const per =
    budget.window === BUDGET_WINDOW.SESSION ? 'this session' : `per ${budget.window}`;
  /* Named as an allowance rather than a refusal: "not allowed" and "no allowance left"
     lead to different fixes, and confusing them sends somebody editing rules. */
  return `${budget.name} has used ${amount} ${per}; there is none left until the window resets`;
}

export function describeSpend(spend: BudgetSpend): string {
  const { budget } = spend;
  const amount =
    budget.unit === BUDGET_UNIT.USD
      ? `$${spend.spent.toFixed(2)} / $${budget.limit.toFixed(2)}`
      : `${spend.spent} / ${budget.limit}`;
  return `${budget.name.padEnd(24)}${amount} per ${budget.window}`;
}

export function validateBudget(budget: Partial<Budget>): string[] {
  const problems: string[] = [];
  if (budget.name === undefined || budget.name.trim() === '') {
    problems.push('a budget needs a name somebody would recognise');
  }
  if (budget.actions === undefined || budget.actions.length === 0) {
    problems.push('a budget must name the actions it covers');
  }
  if (budget.limit === undefined || budget.limit <= 0) {
    problems.push('a budget of zero is a deny rule; write it as one');
  }
  return problems;
}

/**
 * What the rest of the fleet has spent against this budget.
 *
 * Zero for a machine budget and for a fleet budget nobody could count, which are
 * different situations with the same arithmetic: in both, this machine falls back to
 * what it can see itself rather than to no limit at all.
 */
export function elsewhere(budget: Budget, fleet: readonly FleetSpend[]): number {
  if (budget.fleet !== true) return 0;
  const found = fleet.find((each) => each.name === budget.name);
  return found?.spent ?? 0;
}

/** The budgets worth asking the workspace about. */
export function fleetBudgets(budgets: readonly Budget[]): Budget[] {
  return budgets.filter((budget) => budget.fleet === true);
}

/** Hours the workspace should count back over, from a budget's own window. */
export function windowHoursOf(budget: Budget): number {
  if (budget.window === BUDGET_WINDOW.HOUR) return 1;
  if (budget.window === BUDGET_WINDOW.DAY) return 24;
  /* A session has no clock window, so a fleet count over one is meaningless: it
     falls back to this machine's own session, which is what `elsewhere` returns. */
  return 0;
}
