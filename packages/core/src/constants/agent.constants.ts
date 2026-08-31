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

/** Audited action name for a credential rotation. */
export const AGENT_ROTATE_ACTION = 'agent.rotate';
