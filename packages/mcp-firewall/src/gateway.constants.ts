/** Environment variables the gateway reads — the same names its CLI documents. */
export const ENV_UPSTREAM_URL = 'MEMNOX_MCP_UPSTREAM';
export const ENV_UPSTREAM_AUTHORIZATION = 'MEMNOX_MCP_UPSTREAM_AUTHORIZATION';
export const ENV_GATEWAY_PORT = 'MEMNOX_MCP_GATEWAY_PORT';
export const ENV_GATEWAY_HOST = 'MEMNOX_MCP_GATEWAY_HOST';

export const DEFAULT_GATEWAY_PORT = 8765;
export const DEFAULT_GATEWAY_HOST = '127.0.0.1';
export const DEFAULT_GATEWAY_PATH = '/mcp';

/** The agent's own Memnox credential, presented per request. */
export const HEADER_AUTHORIZATION = 'authorization';
export const BEARER_PREFIX = 'Bearer ';
/** MCP's session correlation header; reused to group a client's calls in the audit timeline. */
export const HEADER_MCP_SESSION = 'mcp-session-id';
export const HEADER_CONTENT_TYPE = 'content-type';

export const CONTENT_TYPE_JSON = 'application/json';
export const CONTENT_TYPE_EVENT_STREAM = 'text/event-stream';

/** A request body larger than this is refused before it is parsed. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;
