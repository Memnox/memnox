import { ACTION } from '@memnox/core';

/**
 * The job an agent was enrolled under, matched by a
 * rule's `roles:`, which tells a workforce apart.
 */
export const ENV_AGENT_ROLE = 'MEMNOX_AGENT_ROLE';

/** The agent kind this seam is installed into, used as the default policy identity. */
export const DEFAULT_AGENT_NAME = 'claude-code';

/** An outbound request, ruled on by destination and by what it carries. */
export const EGRESS_REQUEST_ACTION = ACTION.HTTP_REQUEST;
/** A tunnel is a different question from a request: only the destination is knowable. */
export const EGRESS_CONNECT_ACTION = ACTION.HTTP_CONNECT;

/** Actions that carry a payload somewhere this machine does not control. */
export const EGRESS_ACTIONS: readonly string[] = [EGRESS_REQUEST_ACTION, 'data.export'];

/** Loopback only: a proxy reachable from the network is a hole, not a seam. */
export const EGRESS_DEFAULT_PORT = 8888;

/** A body larger than this is not read, and is never treated as though it had been. */
export const EGRESS_MAX_BODY_BYTES = 1_000_000;

/** What an ask with nobody to answer it says, so the fix is named rather than guessed. */
export const NOBODY_TO_ASK =
  'Nobody could be asked, so it was denied. Run the agent under "memnox run".';

/**
 * On the editor hook's command line: rule on every tool call, not only take leases. An
 * install that predates it keeps coordinating only, and the keeper upgrades it.
 */
export const TOOL_POLICY_FLAG = '--policy';
