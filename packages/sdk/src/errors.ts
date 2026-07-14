import type { Decision } from '@memnox/core';

export class MemnoxApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'MemnoxApiError';
  }
}

/** Thrown by guard() when the runtime blocks the action. */
export class ActionBlockedError extends Error {
  constructor(public readonly decision: Decision) {
    super(`Action blocked by Memnox: ${decision.reason}`);
    this.name = 'ActionBlockedError';
  }
}

/** Thrown by guard() when the runtime requires a human approval first. */
export class ApprovalRequiredError extends Error {
  constructor(public readonly decision: Decision) {
    super(`Action requires approval (${decision.approvalId}): ${decision.reason}`);
    this.name = 'ApprovalRequiredError';
  }
}
