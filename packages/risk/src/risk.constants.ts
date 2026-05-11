/** Recent-history window an agent's behavior baseline is computed from. */
export const BASELINE_WINDOW_EVENTS = 500;
/** Session events cumulative llm.spend is reconstructed from. */
export const TOKEN_BUDGET_WINDOW_EVENTS = 1_000;
/** Burst detection: this many actions inside BURST_WINDOW_MS raises a signal. */
export const BURST_THRESHOLD_ACTIONS = 30;
export const BURST_WINDOW_MS = 60_000;
/** Blocked attempts inside the window before repeated probing escalates. */
export const REPEATED_BLOCK_THRESHOLD = 3;
export const REPEATED_BLOCK_WINDOW_MS = 10 * 60_000;
/** Trust score below which high/critical-risk actions need a human. */
export const TRUST_SCORE_APPROVAL_THRESHOLD = 60;

export const RISK_SIGNAL = {
  NOVEL_DESTRUCTIVE_ACTION: 'novel-destructive-action',
  ACTION_BURST: 'action-burst',
  REPEATED_BLOCKS: 'repeated-blocks',
  LOW_TRUST_SCORE: 'low-trust-score',
} as const;

export type RiskSignal = (typeof RISK_SIGNAL)[keyof typeof RISK_SIGNAL];
