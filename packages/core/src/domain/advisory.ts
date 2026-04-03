import type { ActionRequest } from './action-event';
import type { AgentIdentity } from './agent-identity';
import type { DecisionEffect } from '../constants/decision.constants';

/**
 * Advisors extend the gateway with deterministic escalation logic (memory
 * conflicts, behavioral signals). They may only tighten a decision — an
 * advisor can never turn a block into an allow.
 */
export interface Advisory {
  source: string;
  /** Omit to leave the policy decision untouched (signal-only advisory). */
  escalateTo?: Extract<DecisionEffect, 'block' | 'require_approval'>;
  reason: string;
  approvers?: string[];
  /** A block no human may lift: no approval, not even break-glass, satisfies it. Only meaningful with escalateTo "block". */
  nonOverridable?: boolean;
  signals: string[];
}

export interface AdvisoryContext {
  agent: AgentIdentity;
}

export interface ActionAdvisor {
  readonly name: string;
  advise(request: ActionRequest, context: AdvisoryContext): Promise<Advisory[]>;
}
