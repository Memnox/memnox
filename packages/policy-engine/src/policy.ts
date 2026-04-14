import type { DecisionEffect } from '@memnox/core';
import type { TimeWindow } from './time-window';

/** All match fields are lists of wildcard patterns; omitted fields match anything. */
export interface PolicyMatch {
  actions: string[];
  targets?: string[];
  environments?: string[];
  agents?: string[];
  models?: string[];
  providers?: string[];
  dataClassifications?: string[];
  jurisdictions?: string[];
  /** The policy applies only inside these recurring windows. */
  windows?: TimeWindow[];
}

export interface PolicyDecision {
  effect: DecisionEffect;
  reason?: string;
  approvers?: string[];
  /** Distinct people required to approve; defaults to one. */
  minApprovals?: number;
}

export interface Policy {
  name: string;
  description?: string;
  match: PolicyMatch;
  decision: PolicyDecision;
}

export interface PolicyDocument {
  version: number;
  policies: Policy[];
}

export const POLICY_DOCUMENT_VERSION = 1;
