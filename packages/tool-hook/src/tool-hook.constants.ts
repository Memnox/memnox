/** Environment variables the hook reads — the same names the MCP seam documents. */
export const ENV_RUNTIME_URL = 'MEMNOX_URL';
export const ENV_AGENT_TOKEN = 'MEMNOX_AGENT_TOKEN';
/** Policy files evaluated in-process — this is what sees the tool's arguments. */
export const ENV_POLICIES = 'MEMNOX_POLICIES';
/** Name the local rules match on `agents:`; defaults to the agent kind. */
export const ENV_AGENT_NAME = 'MEMNOX_AGENT_NAME';
/** "true" allows the tool when the runtime is unreachable. Default: fail closed. */
export const ENV_FAIL_OPEN = 'MEMNOX_HOOK_FAIL_OPEN';

export const POLICY_PATH_SEPARATOR = ',';

/** The only event this seam answers; anything else is a config error, not a verdict. */
export const HOOK_EVENT_NAME = 'PreToolUse';

/**
 * The three answers the host understands. `allow` is deliberately never emitted:
 * it would skip the permission prompt the person would otherwise have seen, and a
 * seam that widens authority is the trust score this codebase already refused.
 */
export const PERMISSION_DECISION = {
  DENY: 'deny',
  ASK: 'ask',
} as const;

export type PermissionDecision =
  (typeof PERMISSION_DECISION)[keyof typeof PERMISSION_DECISION];

/**
 * 0 lets the host read the JSON on stdout, and an empty stdout means "no opinion",
 * which is what an allowed action gets. Nothing here ever exits non-zero on a verdict:
 * a crash and a refusal must not look the same to whoever reads the transcript.
 */
export const EXIT_OK = 0;
/** Reserved for a hook that could not run at all — never for a withheld action. */
export const EXIT_UNUSABLE_INPUT = 1;

/** The agent kind this seam is installed into, used as the default policy identity. */
export const DEFAULT_AGENT_NAME = 'claude-code';

/**
 * Declared, and shown wherever coverage is reported. A governed agent with an
 * unwatched side channel is worse than an ungoverned one, because somebody believes it.
 */
export const HOOK_BLIND_SPOTS: readonly string[] = [
  "the model's reasoning",
  'anything a shell command does after it is allowed to start',
  'MCP tool calls, which the MCP proxy seam holds instead',
];

/** The ledger's own vocabulary; named here so this package keeps its three deps. */
export const FRAME_TOOL_CALL = 'tool_call';

/** Actions that carry a payload somewhere this machine does not control. */
export const EGRESS_ACTIONS: readonly string[] = ['http.request', 'data.export'];

/** Loopback only: a proxy reachable from the network is a hole, not a seam. */
export const EGRESS_DEFAULT_PORT = 8888;

/** A body larger than this is not read, and is never treated as though it had been. */
export const EGRESS_MAX_BODY_BYTES = 1_000_000;

export const DOCKER_SEAM_SOCKET = '/tmp/memnox-docker.sock';
export const DOCKER_REAL_SOCKET = '/var/run/docker.sock';

/**
 * The operating system's cap on a unix socket path. Over it, `listen` can report
 * success while binding nothing, which would leave the seam claiming coverage it
 * does not have — so it is checked before anything announces itself.
 */
export const DOCKER_SOCKET_PATH_LIMIT = 100;
