import { matchesAny } from '../policy/pattern-matcher';
import { DAY_MS, HOUR_MS, HOURS_IN_A_DAY } from '../domain/time';
import type { MemnoxEvent } from '../event/event';
import { DECISION_EFFECT } from '../constants/decision.constants';

/**
 * Whether an action may happen again, which catches a loop every single call was
 * entitled to make. Counted from the ledger, so killing a process cannot reset it.
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
  /** Counted across the workspace, so three machines allowed twenty each is not sixty. */
  fleet?: boolean;
}

/**
 * What the workspace says has been spent, added to this machine's own count so an
 * unreachable control plane degrades a fleet budget to a machine one rather than none.
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
  [BUDGET_WINDOW.HOUR]: HOUR_MS,
  [BUDGET_WINDOW.DAY]: DAY_MS,
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

/** What one event cost, injected because this machine cannot price a model call. */
export type EventCost = (event: MemnoxEvent) => number;

/** What the row says it cost, the only figure here that is not a guess; absent is zero. */
export const REPORTED_COST: EventCost = (event) => event.costUsd ?? 0;

/** The record a budget is counted against, as of a moment the caller passes in. */
export interface BudgetLedger {
  events: readonly MemnoxEvent[];
  now: string;
  /** Required for a session budget, which counts nothing without one. */
  sessionId?: string;
  costOf?: EventCost;
}

export interface ExhaustionInput extends BudgetLedger {
  action: string;
  /** What this one call would spend against a dollar budget. A call budget counts one. */
  wouldSpendUsd?: number;
  fleet?: readonly FleetSpend[];
}

/** Only what proceeded counts, or a strict policy would exhaust the budget it protects. */
export function spentOn(budget: Budget, ledger: BudgetLedger): number {
  const inWindow = windowOf(budget, ledger.events, ledger.now, ledger.sessionId).filter(
    (event) => coversAction(budget, event.operation) && didHappen(event),
  );
  if (budget.unit === BUDGET_UNIT.CALLS) return inWindow.length;
  const costOf = ledger.costOf ?? REPORTED_COST;
  return inWindow.reduce((total, event) => total + costOf(event), 0);
}

function didHappen(event: MemnoxEvent): boolean {
  // Denied and held calls never ran, so they never spent anything.
  return event.effect === DECISION_EFFECT.ALLOW;
}

export function spendReport(
  budgets: readonly Budget[],
  ledger: BudgetLedger,
): BudgetSpend[] {
  return budgets.map((budget) => {
    const spent = spentOn(budget, ledger);
    return { budget, spent, remaining: Math.max(0, budget.limit - spent) };
  });
}

/** The first budget this action would exceed, checked before it runs rather than after. */
export function exhaustedBy(
  budgets: readonly Budget[],
  input: ExhaustionInput,
): BudgetBreach | null {
  for (const budget of budgets) {
    if (!coversAction(budget, input.action)) continue;
    const spent = spentOn(budget, input) + elsewhere(budget, input.fleet ?? []);
    const wants = budget.unit === BUDGET_UNIT.USD ? (input.wouldSpendUsd ?? 1) : 1;
    if (spent + wants <= budget.limit) continue;
    return { budget, spent, reason: describeBreach(budget, spent) };
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
  // An allowance rather than a refusal, because "not allowed" sends somebody editing rules.
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
 * What the rest of the fleet has spent against this budget. Zero when nobody could
 * count, so an uncounted fleet falls back to this machine's view rather than no limit.
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
  if (budget.window === BUDGET_WINDOW.DAY) return HOURS_IN_A_DAY;
  // A session has no clock window, so a fleet count over one falls back to this machine.
  return 0;
}
