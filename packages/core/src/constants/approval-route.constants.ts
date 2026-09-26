/**
 * Where a question goes when the agent's own prompt cannot carry it. The session is
 * always asked; the only choice is whether the person's DM is asked as well.
 */
export const APPROVAL_ROUTE = {
  /** Asked in the agent's session, and answered there. Nothing leaves the machine. */
  SESSION: 'session',
  /** The session and the person's Slack or Discord DM, whichever answers first. */
  BOTH: 'both',
} as const;

export type ApprovalRoute = (typeof APPROVAL_ROUTE)[keyof typeof APPROVAL_ROUTE];

const ROUTES: readonly string[] = Object.values(APPROVAL_ROUTE);

export function isApprovalRoute(value: string): value is ApprovalRoute {
  return ROUTES.includes(value);
}

/**
 * A route as written, with the DM-only word an earlier build accepted read as `both`,
 * since the session is now always asked and that person did want their DM.
 */
export function approvalRouteOf(value: string): ApprovalRoute | null {
  if (value === 'dm') return APPROVAL_ROUTE.BOTH;
  return isApprovalRoute(value) ? value : null;
}
