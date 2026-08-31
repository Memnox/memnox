import type { Alternative } from '@memnox/core';
import { DECISION_EFFECT } from '@memnox/core';
import type { HookVerdict } from './hook-authorizer';
import {
  HOOK_EVENT_NAME,
  PERMISSION_DECISION,
  type PermissionDecision,
} from './tool-hook.constants';

export interface HookResponse {
  hookSpecificOutput: {
    hookEventName: typeof HOOK_EVENT_NAME;
    permissionDecision: PermissionDecision;
    permissionDecisionReason: string;
  };
}

/**
 * Empty stdout for an allow, and that silence is deliberate: answering "allow" would
 * skip the permission prompt the person would otherwise have seen, so this seam can
 * only ever hold an action back or hand it to somebody. It never widens authority.
 */
export function encodeVerdict(verdict: HookVerdict): string {
  const response = responseFor(verdict);
  if (response === null) return '';
  return JSON.stringify(response);
}

function responseFor(verdict: HookVerdict): HookResponse | null {
  if (verdict.effect === DECISION_EFFECT.ALLOW) return null;

  const decision =
    verdict.effect === DECISION_EFFECT.ESCALATE
      ? PERMISSION_DECISION.ASK
      : PERMISSION_DECISION.DENY;

  return {
    hookSpecificOutput: {
      hookEventName: HOOK_EVENT_NAME,
      permissionDecision: decision,
      permissionDecisionReason: reasonFor(verdict),
    },
  };
}

/**
 * The alternative rides all the way to the model, or the refusal is a dead end. An
 * agent told only no abandons the task; one told what to use instead finishes it.
 */
function reasonFor(verdict: HookVerdict): string {
  const parts = [verdict.reason];

  if (verdict.alternative !== undefined) {
    parts.push(`Instead: ${describe(verdict.alternative)}`);
  }
  if (verdict.approvalId !== undefined) {
    parts.push(
      `A person can answer this: memnox approvals resolve ${verdict.approvalId} --by <you>`,
    );
  }
  if (verdict.decisionId !== undefined) {
    parts.push(`Why: memnox why ${verdict.decisionId}`);
  }
  return parts.join(' ');
}

function describe(alternative: Alternative): string {
  const target = alternative.resource === undefined ? '' : ` ${alternative.resource}`;
  return `${alternative.action}${target} — ${alternative.note}`;
}
