/** Three effects, not two: the third is what keeps a governed system from being a wall. */
export const DECISION_EFFECT = {
  ALLOW: 'allow',
  WITHHOLD: 'withhold',
  ESCALATE: 'escalate',
} as const;

export type DecisionEffect = (typeof DECISION_EFFECT)[keyof typeof DECISION_EFFECT];

/** Higher value wins when several rules match: withhold overrides allow at equal priority. */
export const EFFECT_PRECEDENCE: Record<DecisionEffect, number> = {
  [DECISION_EFFECT.ALLOW]: 0,
  [DECISION_EFFECT.ESCALATE]: 1,
  [DECISION_EFFECT.WITHHOLD]: 2,
};

export const DECISION_REASON = {
  NO_POLICY_MATCHED: 'no policy matched — default effect applied',
  UNKNOWN_AGENT: 'unknown agent credentials — fail closed',
  AGENT_SUSPENDED: 'agent is suspended',
  APPROVAL_GRANTED: 'human approval granted',
  APPROVAL_PENDING: 'human approval required and pending',
  CAPABILITY: "capability: action is outside this agent's declared capabilities",
  BREAK_GLASS_OVERRIDE: 'break-glass override',
  NON_OVERRIDABLE: 'non-overridable withhold — no approval can satisfy this action',
  RATE_LIMIT: 'rate limit exceeded for this rule',
  OUT_OF_DECLARED_SCOPE: 'this was not part of what the task declared',
} as const;
