import type { ContextBlock } from '@memnox/core';

/**
 * What a delegation hands over: the objective, the context with its trust levels, the
 * constraints, and a capability rather than a key.
 */
export interface Briefing {
  runId: string;
  stepId: string;
  objective: string;
  /**
   * Trust carried through. Losing it at the boundary reopens the injection path the
   * decision object closed: an agent receiving work has to know which parts of its
   * context are quotations from the outside world.
   */
  context: ContextBlock[];
  constraints: {
    deadline?: string;
    budgetCents?: number;
    allowed: string[];
    forbidden: string[];
  };
  /** A lease, never a stored secret. Expiry belongs to the issuer. */
  capability: { token: string; expiresAt: string; scope: Record<string, string> };
  /** Lineage survives the handoff, so a delegated run is a hop rather than a new actor. */
  correlationId: string;
  callback: { resultUrl: string; mcpUrl?: string };
}

/** Memnox never does the work: a briefing describes it and hands it to somebody else. */
export function isWellFormed(briefing: Briefing): boolean {
  if (briefing.objective.length === 0) return false;
  if (briefing.correlationId.length === 0) return false;
  if (briefing.capability.token.length === 0) return false;
  return briefing.constraints.allowed.length > 0;
}
