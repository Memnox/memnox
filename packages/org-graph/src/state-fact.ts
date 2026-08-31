/**
 * The company's current condition. State is a policy input: a merge refused because
 * incident 928 is open and the freeze is active is organizational intelligence
 * enforcing an action, which is the whole thesis in one verdict.
 */
export const STATE_FACT_KIND = {
  FREEZE: 'freeze',
  INCIDENT: 'incident',
  CHANGE_WINDOW: 'change_window',
  CONTRACT_TERM: 'contract_term',
  ACCOUNT_HOLD: 'account_hold',
  REVIEW_MISSING: 'review_missing',
} as const;

export type StateFactKind = (typeof STATE_FACT_KIND)[keyof typeof STATE_FACT_KIND];

export interface StateFactScope {
  services?: string[];
  repositories?: string[];
  environments?: string[];
  customers?: string[];
}

export interface StateFact {
  id: string;
  workspaceId: string;
  kind: StateFactKind;
  scope: StateFactScope;
  value: string;
  /** What it points at: "INC-928". */
  ref?: string;
  validFrom: string;
  /**
   * Mandatory. A freeze that outlives the incident it belonged to is worse than no
   * freeze, because the next one gets ignored.
   */
  validUntil: string;
  version: number;
}

export const STATE_FACT_REFUSAL = {
  NO_EXPIRY:
    'a state fact must carry validUntil — a freeze with no end is worse than none',
  BACKWARDS: 'validUntil must be after validFrom',
} as const;

export type StateFactCheck = { ok: true } | { ok: false; reason: string };

/** Refused at write, not filtered at read: an expiry nobody set cannot be added later. */
export function validateStateFact(fact: StateFact): StateFactCheck {
  if (typeof fact.validUntil !== 'string' || fact.validUntil.length === 0) {
    return { ok: false, reason: STATE_FACT_REFUSAL.NO_EXPIRY };
  }
  if (Date.parse(fact.validUntil) <= Date.parse(fact.validFrom)) {
    return { ok: false, reason: STATE_FACT_REFUSAL.BACKWARDS };
  }
  return { ok: true };
}

export function isInForce(fact: StateFact, at: Date): boolean {
  const now = at.getTime();
  return Date.parse(fact.validFrom) <= now && now < Date.parse(fact.validUntil);
}

/**
 * Facts are small, versioned, and carry an expiry, so they ride inside the bundle and
 * the evaluator still decides locally in microseconds rather than calling a service.
 */
export function compileStateFacts(
  facts: readonly StateFact[],
  at: Date,
): { facts: StateFact[]; dropped: StateFact[] } {
  const live: StateFact[] = [];
  const dropped: StateFact[] = [];
  for (const fact of facts) {
    if (isInForce(fact, at)) live.push(fact);
    else dropped.push(fact);
  }
  return { facts: live, dropped };
}

/** A fact still in force after its window is a finding, not a mystery. */
export function overdueFacts(facts: readonly StateFact[], at: Date): StateFact[] {
  return facts.filter((fact) => Date.parse(fact.validUntil) <= at.getTime());
}

/**
 * A verdict says which state version it used, so a freeze that never propagated is a
 * finding rather than an unexplained allow.
 */
export function stateVersion(facts: readonly StateFact[]): string {
  if (facts.length === 0) return '0';
  return String(facts.reduce((total, fact) => total + fact.version, 0));
}

export function matchesScope(fact: StateFact, subject: StateFactScope): boolean {
  const dimensions: (keyof StateFactScope)[] = [
    'services',
    'repositories',
    'environments',
    'customers',
  ];
  for (const dimension of dimensions) {
    const declared = fact.scope[dimension];
    if (declared === undefined || declared.length === 0) continue;
    const actual = subject[dimension];
    if (actual === undefined || actual.length === 0) return false;
    if (!actual.some((value) => declared.includes(value))) return false;
  }
  return true;
}
