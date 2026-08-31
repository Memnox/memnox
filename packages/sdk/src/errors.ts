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

/** A refusal that names the permitted path gets taken; one that names nothing gets abandoned. */
function withAlternative(decision: Decision): string {
  const alternative = decision.alternative;
  if (alternative === undefined) return decision.reason;
  const resource = alternative.resource === undefined ? '' : ` ${alternative.resource}`;
  return `${decision.reason} — instead: ${alternative.action}${resource} (${alternative.note})`;
}

/** Thrown by guard() when the runtime withholds the action. */
export class ActionWithheldError extends Error {
  constructor(public readonly decision: Decision) {
    super(`Action withheld by Memnox: ${withAlternative(decision)}`);
    this.name = 'ActionWithheldError';
  }
}

/** Thrown by guard() when the runtime escalates to a person first. */
export class EscalationRequiredError extends Error {
  constructor(public readonly decision: Decision) {
    super(`Action escalated (${decision.approvalId}): ${withAlternative(decision)}`);
    this.name = 'EscalationRequiredError';
  }
}
