import type { ActionRequest } from './action-event';
import type { AgentIdentity } from './agent-identity';
import type { DecisionEffect } from '../constants/decision.constants';

/** Deterministic escalation: an advisor may only tighten, never turn a withhold into allow. */
export interface Advisory {
  source: string;
  /** Omit to leave the policy decision untouched (signal-only advisory). */
  escalateTo?: Extract<DecisionEffect, 'withhold' | 'escalate'>;
  reason: string;
  approvers?: string[];
  /** No approval, not even break-glass, satisfies it. Only with escalateTo "withhold". */
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
