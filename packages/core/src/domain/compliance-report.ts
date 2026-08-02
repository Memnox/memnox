export interface ComplianceReport {
  generatedAt: string;
  period: { from?: string; to?: string };
  totals: {
    actions: number;
    allowed: number;
    blocked: number;
    approvalsRequired: number;
  };
  riskBreakdown: Record<string, number>;
  topBlockedActions: Array<{ action: string; count: number }>;
  policyActivity: Array<{ policy: string; count: number }>;
  agentActivity: Array<{ agent: string; actions: number; blocked: number }>;
  advisorySignals: Array<{ signal: string; count: number }>;
  verification: VerificationCoverage;
}

/**
 * How many allowed decisions came back with an outcome. The runtime cannot
 * observe the outside world, so "unreported" means no testimony arrived — an
 * action whose caller never used runGuarded, not an action that failed.
 */
export interface VerificationCoverage {
  allowed: number;
  reported: number;
  unreported: number;
  /**
   * Allowed too recently for testimony to be overdue — the action may still be
   * running. Counted apart from "unreported" so a fresh decision never reads as
   * a caller that failed to report.
   */
  inFlight: number;
  succeeded: number;
  /** Ran but could not be verified, or never ran because a precondition failed. */
  failed: number;
  rolledBack: number;
  /** The worst case: ran, unverified, and could not be undone. */
  rollbackFailed: number;
  /** Allowed actions still awaiting testimony, most frequent first. */
  unreportedActions: Array<{ action: string; count: number }>;
}
