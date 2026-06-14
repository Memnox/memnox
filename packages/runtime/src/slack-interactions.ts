import { createHmac, timingSafeEqual } from 'node:crypto';

const SLACK_SIGNATURE_VERSION = 'v0';
/** Requests older than this are replays — reject them. */
const SLACK_MAX_AGE_S = 300;

export const SLACK_ACTION_APPROVE = 'memnox_approve';
export const SLACK_ACTION_DENY = 'memnox_deny';

export interface SlackInteraction {
  approvalId: string;
  approved: boolean;
  resolvedBy: string;
}

/** Standard Slack request signing: v0=HMAC-SHA256("v0:<timestamp>:<body>"). */
export function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  rawBody: string,
  signature: string,
  now: Date = new Date(),
): boolean {
  const age = Math.abs(now.getTime() / 1_000 - Number(timestamp));
  if (!Number.isFinite(age) || age > SLACK_MAX_AGE_S) return false;

  const expected = `${SLACK_SIGNATURE_VERSION}=${createHmac('sha256', signingSecret)
    .update(`${SLACK_SIGNATURE_VERSION}:${timestamp}:${rawBody}`)
    .digest('hex')}`;
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signature);
  if (expectedBuffer.length !== actualBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, actualBuffer);
}

/** Parses a Slack block_actions payload into an approval resolution, or null. */
const DEFAULT_SLACK_USER = 'slack-user';

/** Slack sends username on some payloads and name on others; either identifies the human. */
function slackUserName(user?: { username?: string; name?: string }): string {
  if (user === undefined) return DEFAULT_SLACK_USER;
  if (user.username !== undefined) return user.username;
  if (user.name !== undefined) return user.name;
  return DEFAULT_SLACK_USER;
}

export function parseSlackInteraction(rawBody: string): SlackInteraction | null {
  const payloadJson = new URLSearchParams(rawBody).get('payload');
  if (!payloadJson) return null;
  let payload: {
    type?: string;
    user?: { username?: string; name?: string };
    actions?: Array<{ action_id?: string; value?: string }>;
  };
  try {
    payload = JSON.parse(payloadJson) as typeof payload;
  } catch {
    return null;
  }
  if (payload.type !== 'block_actions') return null;
  const actions = payload.actions;
  const action = actions === undefined ? undefined : actions[0];
  if (action === undefined || !action.value) return null;
  if (
    action.action_id !== SLACK_ACTION_APPROVE &&
    action.action_id !== SLACK_ACTION_DENY
  ) {
    return null;
  }
  return {
    approvalId: action.value,
    approved: action.action_id === SLACK_ACTION_APPROVE,
    resolvedBy: slackUserName(payload.user),
  };
}
