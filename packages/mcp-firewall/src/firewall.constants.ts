/** Environment variables the firewall reads — the same names the CLI documents. */
export const ENV_RUNTIME_URL = 'MEMNOX_URL';
export const ENV_AGENT_TOKEN = 'MEMNOX_AGENT_TOKEN';
export const ENV_TOOLS_ALLOW = 'MEMNOX_TOOLS_ALLOW';
export const ENV_TOOLS_DENY = 'MEMNOX_TOOLS_DENY';
/** "true" makes the firewall forward calls when the runtime is unreachable. Default: fail closed. */
export const ENV_FAIL_OPEN = 'MEMNOX_MCP_FAIL_OPEN';
/** Policy files evaluated in-process, comma-separated — this is what sees the arguments. */
export const ENV_POLICIES = 'MEMNOX_POLICIES';
/** Name the local rules match on `agents:`; defaults to the wrapped server's. */
export const ENV_AGENT_NAME = 'MEMNOX_AGENT_NAME';

export const POLICY_PATH_SEPARATOR = ',';

export const MCP_ACTION_PREFIX = 'mcp';
export const METHOD_TOOLS_CALL = 'tools/call';
export const METHOD_TOOLS_LIST = 'tools/list';
