export const AGENT_KIND = {
  CLAUDE_CODE: 'claude-code',
  CURSOR: 'cursor',
  OPENAI_AGENT: 'openai-agent',
  MCP: 'mcp',
  CUSTOM: 'custom',
} as const;

export type AgentKind = (typeof AGENT_KIND)[keyof typeof AGENT_KIND];

export const AGENT_STATUS = {
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
} as const;

export type AgentStatus = (typeof AGENT_STATUS)[keyof typeof AGENT_STATUS];

export const TRUST_SCORE_MAX = 100;
export const TRUST_SCORE_MIN = 0;
/** Each withheld action costs this many points until offset by successful ones. */
export const TRUST_PENALTY_PER_WITHHOLD = 2;
/** Allowed actions needed to earn back one penalty point. */
export const TRUST_RECOVERY_ALLOWED_ACTIONS = 50;

/** Audited action name for a credential rotation. */
export const AGENT_ROTATE_ACTION = 'agent.rotate';
