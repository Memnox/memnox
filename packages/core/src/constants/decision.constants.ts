export const DECISION_EFFECT = {
  ALLOW: 'allow',
  BLOCK: 'block',
  REQUIRE_APPROVAL: 'require_approval',
} as const;

export type DecisionEffect = (typeof DECISION_EFFECT)[keyof typeof DECISION_EFFECT];

/** Higher value wins when multiple policies match — most restrictive effect prevails. */
export const EFFECT_PRECEDENCE: Record<DecisionEffect, number> = {
  [DECISION_EFFECT.ALLOW]: 0,
  [DECISION_EFFECT.REQUIRE_APPROVAL]: 1,
  [DECISION_EFFECT.BLOCK]: 2,
};

export const DECISION_REASON = {
  NO_POLICY_MATCHED: 'no policy matched — default effect applied',
  UNKNOWN_AGENT: 'unknown agent credentials — fail closed',
  AGENT_SUSPENDED: 'agent is suspended',
  APPROVAL_GRANTED: 'human approval granted',
  APPROVAL_PENDING: 'human approval required and pending',
  CAPABILITY: "capability: action is outside this agent's declared capabilities",
  BREAK_GLASS_OVERRIDE: 'break-glass override',
  NON_OVERRIDABLE: 'non-overridable block — no approval can satisfy this action',
} as const;
