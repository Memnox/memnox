/** Where a question goes when the agent's own prompt cannot carry it. */
export const APPROVAL_ROUTE = {
  /** Asked in the agent's session, and answered there. Nothing leaves the machine. */
  SESSION: 'session',
  /** Sent to Slack or Discord through the workspace, and answered there. */
  DM: 'dm',
  /** Both at once: whichever answer arrives first is the one that counts. */
  BOTH: 'both',
} as const;

export type ApprovalRoute = (typeof APPROVAL_ROUTE)[keyof typeof APPROVAL_ROUTE];

const ROUTES: readonly string[] = Object.values(APPROVAL_ROUTE);

export function isApprovalRoute(value: string): value is ApprovalRoute {
  return ROUTES.includes(value);
}
