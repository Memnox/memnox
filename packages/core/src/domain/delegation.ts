/**
 * Every agent's authority came from somewhere. Not an API key: a person, through a
 * chain the product can print.
 */
export interface Delegation {
  id: string;
  /** Either may be an agent: one handing work to another is a delegation, not a category. */
  issuerId: string;
  delegateId: string;
  authority: {
    actions: string[];
    ceilings?: { budgetCents?: number; maxRisk?: string; resourceScope?: string[] };
  };
  scope: Record<string, string>;
  transferable: boolean;
  expiresAt: string;
  revokedAt?: string;
  parentId?: string;
}

export const DELEGATION_REFUSAL = {
  NOT_HELD: 'an agent cannot delegate what it does not hold',
  NOT_TRANSFERABLE: 'that authority was not marked transferable',
  EXPIRED: 'the issuing delegation has expired',
  REVOKED: 'the issuing delegation was revoked',
} as const;

export type DelegationRefusal =
  (typeof DELEGATION_REFUSAL)[keyof typeof DELEGATION_REFUSAL];

export type DelegationCheck = { ok: true } | { ok: false; reason: DelegationRefusal };

const OK: DelegationCheck = { ok: true };

/** A live parent, checked at issue and again at use: a revoked person leaves no live chain. */
export function isDelegationLive(delegation: Delegation, now: Date): DelegationCheck {
  if (delegation.revokedAt !== undefined) {
    return { ok: false, reason: DELEGATION_REFUSAL.REVOKED };
  }
  if (Date.parse(delegation.expiresAt) <= now.getTime()) {
    return { ok: false, reason: DELEGATION_REFUSAL.EXPIRED };
  }
  return OK;
}

/**
 * A chain can only narrow. Checked at issue against the issuer's authority and again at
 * use, because the issuer's authority may have been revoked since — both, or a revoked
 * person leaves a live chain behind them.
 */
export function canDelegate(
  parent: Delegation | null,
  requested: Delegation,
  now: Date,
  matches: (patterns: readonly string[], value: string) => boolean,
): DelegationCheck {
  // A root delegation comes from a person, whose authority is not itself a delegation.
  if (parent === null) return OK;

  const live = isDelegationLive(parent, now);
  if (!live.ok) return live;
  if (!parent.transferable) {
    return { ok: false, reason: DELEGATION_REFUSAL.NOT_TRANSFERABLE };
  }
  for (const action of requested.authority.actions) {
    if (!matches(parent.authority.actions, action)) {
      return { ok: false, reason: DELEGATION_REFUSAL.NOT_HELD };
    }
  }
  const parentBudget = budgetOf(parent);
  const childBudget = budgetOf(requested);
  if (
    parentBudget !== undefined &&
    (childBudget === undefined || childBudget > parentBudget)
  ) {
    return { ok: false, reason: DELEGATION_REFUSAL.NOT_HELD };
  }
  if (Date.parse(requested.expiresAt) > Date.parse(parent.expiresAt)) {
    return { ok: false, reason: DELEGATION_REFUSAL.NOT_HELD };
  }
  return OK;
}

/** A missing ceiling is no ceiling, which is exactly what a chain must not silently gain. */
function budgetOf(delegation: Delegation): number | undefined {
  const ceilings = delegation.authority.ceilings;
  if (ceilings === undefined) return undefined;
  return ceilings.budgetCents;
}

/** The chain the product can print, from the person at the root to the agent acting. */
export function chainOf(
  delegation: Delegation,
  byId: ReadonlyMap<string, Delegation>,
): Delegation[] {
  const chain: Delegation[] = [delegation];
  let parentId = delegation.parentId;
  // A cycle would be a corrupt store rather than a real chain; the seen set stops it.
  const seen = new Set([delegation.id]);
  while (parentId !== undefined && !seen.has(parentId)) {
    const parent = byId.get(parentId);
    if (parent === undefined) break;
    seen.add(parent.id);
    chain.unshift(parent);
    parentId = parent.parentId;
  }
  return chain;
}
