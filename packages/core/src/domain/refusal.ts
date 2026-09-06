import { DECISION_EFFECT, type DecisionEffect } from '../constants/decision.constants';

/**
 * Whether trying again could ever work.
 *
 * A denial that reads like a transient failure gets retried, and an agent retrying a
 * policy decision forty times is the loop the circuit breaker exists to stop — so the
 * cheapest place to stop it is the refusal itself. The model is told plainly, in the
 * one message it is going to read.
 */
export const RETRYABILITY = {
  /** A rule refused it. The same call will be refused again, for ever. */
  NEVER: 'never',
  /** Refused for a reason that expires: a freeze, a budget window, a lease. */
  LATER: 'later',
  /** Somebody can release it. The call is not wrong, it is unapproved. */
  ON_APPROVAL: 'on-approval',
} as const;

export type Retryability = (typeof RETRYABILITY)[keyof typeof RETRYABILITY];

export interface RefusalShape {
  retryability: Retryability;
  /** The sentence the model reads about retrying. Never a hint, always an instruction. */
  guidance: string;
}

/**
 * Reasons that expire on their own. A freeze lifts, a window rolls over, a lease ends:
 * telling a model "never" about one of those is as wrong as telling it "soon" about a
 * rule, because it abandons work that would have been fine in an hour.
 */
const EXPIRES = ['freeze', 'frozen', 'budget', 'exhausted', 'lease', 'held by', 'window'];

export function refusalShapeFor(effect: DecisionEffect, reason: string): RefusalShape {
  if (effect === DECISION_EFFECT.ASK) {
    return {
      retryability: RETRYABILITY.ON_APPROVAL,
      guidance:
        'This is waiting on a person, not a failure. Do not retry; the call resumes when it is answered.',
    };
  }

  const lowered = reason.toLowerCase();
  if (EXPIRES.some((word) => lowered.includes(word))) {
    return {
      retryability: RETRYABILITY.LATER,
      guidance:
        'This is a temporary condition, not a permanent rule. Do not retry now; it may succeed once the condition clears.',
    };
  }

  return {
    retryability: RETRYABILITY.NEVER,
    guidance:
      'This is a policy decision, not a transient failure. Retrying will fail identically. Take the alternative, or ask a person to change the rule.',
  };
}
