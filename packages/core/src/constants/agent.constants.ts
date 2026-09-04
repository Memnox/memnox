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
  /** Held read-only by quarantine: reads pass, everything else is denied. */
  QUARANTINED: 'quarantined',
} as const;

export type AgentStatus = (typeof AGENT_STATUS)[keyof typeof AGENT_STATUS];

/**
 * The identity recorded when a token resolves to nobody. It belongs in the trail — the
 * attempt happened — but it is not an agent: nothing was ever granted to it, so any
 * report phrased as "what you gave this agent" has to leave it out.
 */
export const UNKNOWN_AGENT_ID = 'unknown';

/** Audited action name for a credential rotation. */
export const AGENT_ROTATE_ACTION = 'agent.rotate';
