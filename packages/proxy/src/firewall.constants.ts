export const ENV_TOOLS_ALLOW = 'MEMNOX_TOOLS_ALLOW';
export const ENV_TOOLS_DENY = 'MEMNOX_TOOLS_DENY';

/** Policy files evaluated in-process, comma-separated — this is what sees the arguments. */
export const ENV_POLICIES = 'MEMNOX_POLICIES';
/** Name the local rules match on `agents:`; defaults to the wrapped server's. */
export const ENV_AGENT_NAME = 'MEMNOX_AGENT_NAME';

export const POLICY_PATH_SEPARATOR = ',';

export const MCP_ACTION_PREFIX = 'mcp';
export const METHOD_TOOLS_CALL = 'tools/call';
export const METHOD_TOOLS_LIST = 'tools/list';

/**
 * What this seam sees, and what it cannot. Declared rather than inferred: a governed
 * agent with an unwatched side channel is worse than an ungoverned one.
 */
export const MCP_PROXY_COVERS: readonly string[] = [`${MCP_ACTION_PREFIX}.*`];

export const MCP_PROXY_BLIND_SPOTS: readonly string[] = [
  "the model's reasoning",
  'anything the agent does without a tool call',
  "the wrapped server's own side effects once a call is allowed through",
];
