/** Attribution before optimisation: per workspace, per agent, per model. */
export interface CostEvent {
  id: string;
  workspaceId: string;
  at: string;
  subjectId: string;
  runId?: string;
  stepId?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cents: number;
  /** Who is actually paying. A workspace quietly spending someone else's credit surprises both. */
  payer: 'workspace' | 'deployment';
}

export const CEILING_BREACH = {
  WITHHOLD: 'withhold',
  ESCALATE: 'escalate',
  NOTIFY: 'notify',
} as const;

export type CeilingBreach = (typeof CEILING_BREACH)[keyof typeof CEILING_BREACH];

/** A limit that only warns is discovered in an invoice. */
export interface Ceiling {
  workspaceId: string;
  scope: 'workspace' | 'subject' | 'role';
  scopeId: string;
  window: string;
  limitCents: number;
  onBreach: CeilingBreach;
}

export interface SpendCounter {
  scopeId: string;
  window: string;
  cents: number;
}

/**
 * Incremented on write, so current spend is a read of one row rather than a sum over
 * the period. A ceiling that had to scan the history would be checked too rarely to bite.
 */
export function applySpend(
  counters: readonly SpendCounter[],
  event: CostEvent,
  window: string,
): SpendCounter[] {
  const next = counters.map((counter) => ({ ...counter }));
  const existing = next.find(
    (counter) => counter.scopeId === event.subjectId && counter.window === window,
  );
  if (existing === undefined) {
    next.push({ scopeId: event.subjectId, window, cents: event.cents });
    return next;
  }
  existing.cents += event.cents;
  return next;
}

export interface CeilingVerdict {
  breached: boolean;
  /** What the evaluator should do about it, as an obligation rather than a side switch. */
  effect?: CeilingBreach;
  spentCents: number;
  limitCents: number;
}

/**
 * The ceiling is a policy input, not a separate switch. Spend crossing the limit is an
 * obligation the evaluator reads, so a breach produces a verdict with a reason instead
 * of an unexplained failure somewhere else.
 */
export function checkCeiling(
  ceiling: Ceiling,
  counters: readonly SpendCounter[],
): CeilingVerdict {
  const counter = counters.find(
    (each) => each.scopeId === ceiling.scopeId && each.window === ceiling.window,
  );
  const spentCents = counter === undefined ? 0 : counter.cents;
  if (spentCents < ceiling.limitCents) {
    return { breached: false, spentCents, limitCents: ceiling.limitCents };
  }
  return {
    breached: true,
    effect: ceiling.onBreach,
    spentCents,
    limitCents: ceiling.limitCents,
  };
}

/**
 * Relative to a base model, never in currency in the interface. A price per token
 * belongs to the provider and changes without telling us.
 */
export function relativeCost(cents: number, baseCents: number): number {
  if (baseCents <= 0) return 0;
  return cents / baseCents;
}
