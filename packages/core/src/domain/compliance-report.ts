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

/** Allowed decisions that reported back; "unreported" means no testimony, not failure. */
export interface VerificationCoverage {
  allowed: number;
  reported: number;
  unreported: number;
  /** Too recent for testimony to be overdue, so a fresh decision never reads as a failure. */
  inFlight: number;
  succeeded: number;
  /** Ran but could not be verified, or never ran because a precondition failed. */
  failed: number;
  rolledBack: number;
  /** The worst case: ran, unverified, and could not be undone. */
  rollbackFailed: number;
  /** An agent reporting it ignored the gate — not coverage; it belongs atop the report. */
  defied: number;
  /** Allowed actions still awaiting testimony, most frequent first. */
  unreportedActions: Array<{ action: string; count: number }>;
}
