/** Environment variables the firewall reads — the same names the CLI documents. */
export const ENV_RUNTIME_URL = 'MEMNOX_URL';
export const ENV_AGENT_TOKEN = 'MEMNOX_AGENT_TOKEN';
export const ENV_TOOLS_ALLOW = 'MEMNOX_TOOLS_ALLOW';
export const ENV_TOOLS_DENY = 'MEMNOX_TOOLS_DENY';
/** "true" makes the firewall forward calls when the runtime is unreachable. Default: fail closed. */
export const ENV_FAIL_OPEN = 'MEMNOX_MCP_FAIL_OPEN';

export const MCP_ACTION_PREFIX = 'mcp';
export const METHOD_TOOLS_CALL = 'tools/call';
export const METHOD_TOOLS_LIST = 'tools/list';
