/** Policy files evaluated in-process — this is what sees the tool's arguments. */
export const ENV_POLICIES = 'MEMNOX_POLICIES';
/** Name the local rules match on `agents:`; defaults to the agent kind. */
export const ENV_AGENT_NAME = 'MEMNOX_AGENT_NAME';

export const POLICY_PATH_SEPARATOR = ',';

/** The agent kind this seam is installed into, used as the default policy identity. */
export const DEFAULT_AGENT_NAME = 'claude-code';

/** Actions that carry a payload somewhere this machine does not control. */
export const EGRESS_ACTIONS: readonly string[] = ['http.request', 'data.export'];

/** Loopback only: a proxy reachable from the network is a hole, not a seam. */
export const EGRESS_DEFAULT_PORT = 8888;

/** A body larger than this is not read, and is never treated as though it had been. */
export const EGRESS_MAX_BODY_BYTES = 1_000_000;
