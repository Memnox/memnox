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
}
